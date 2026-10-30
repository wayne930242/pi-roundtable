import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SQL } from "bun";
import {
	createLocalJWKSet,
	exportJWK,
	generateKeyPair,
	type JWK,
	SignJWT,
} from "jose";
import type { ActorFacts } from "pi-roundtable";
import {
	describeDb,
	recordingLogger,
	testDatabaseUrl,
} from "pi-roundtable/testing";
import type { ResolvedOidc } from "../options.ts";
import type { Identified, Visitor } from "../visitors.ts";
import { OidcLogin, type SignedIn } from "./oidc.ts";
import { WebSessions } from "./sessions.ts";

const ISSUER = "https://idp.example.test";
const CLIENT = "web-console";
const ORIGIN = "https://console.example.test";
const MOUNT = "/console";
const DAY = 86_400_000;

const settings = (over: Partial<ResolvedOidc> = {}): ResolvedOidc => ({
	mode: "oidc",
	issuer: ISSUER,
	discoveryUrl: `${ISSUER}/.well-known/openid-configuration`,
	clientId: CLIENT,
	clientSecretEnv: undefined,
	scopes: ["openid", "profile"],
	subjectClaim: "sub",
	nameClaim: undefined,
	rolesClaim: "roles",
	check: undefined,
	sessionDays: 30,
	endSession: false,
	reauthHours: undefined,
	storeClaims: [],
	onSessionVerified: undefined,
	...over,
});

/** A provider that exists only in this file: it signs id_tokens and checks the PKCE verifier. */
async function provider() {
	const pair = await generateKeyPair("RS256");
	const jwk: JWK = {
		...(await exportJWK(pair.publicKey)),
		kid: "k1",
		alg: "RS256",
	};
	const keys = createLocalJWKSet({ keys: [jwk] });
	/** What the next token response carries. */
	const issue: {
		claims: Record<string, unknown>;
		nonce: (given: string) => string;
		issuer: string;
	} = {
		claims: { sub: "u-1", name: "Ada", roles: ["staff"] },
		nonce: (given) => given,
		issuer: ISSUER,
	};
	/** The authorization requests seen, by code. */
	const codes = new Map<string, URL>();
	const authorize = (location: string): string => {
		const url = new URL(location);
		const code = `code-${codes.size + 1}`;
		codes.set(code, url);
		return code;
	};
	const fetcher = (async (_url: string, init?: RequestInit) => {
		const form = new URLSearchParams(String(init?.body));
		const request = codes.get(form.get("code") ?? "");
		const challenge = request?.searchParams.get("code_challenge");
		const verifier = form.get("code_verifier") ?? "";
		const proven =
			challenge ===
			createHash("sha256").update(verifier).digest().toString("base64url");
		if (!request || !proven)
			return new Response("{}", { status: 400, statusText: "bad grant" });
		const token = await new SignJWT({
			...issue.claims,
			nonce: issue.nonce(request.searchParams.get("nonce") ?? ""),
		})
			.setProtectedHeader({ alg: "RS256", kid: "k1" })
			.setIssuer(issue.issuer)
			.setAudience(CLIENT)
			.setIssuedAt()
			.setExpirationTime("1h")
			.sign(pair.privateKey);
		return Response.json({ id_token: token });
	}) as unknown as typeof fetch;
	return { keys, fetcher, issue, authorize };
}

const cookiesOf = (response: Response): string =>
	response.headers
		.getSetCookie()
		.map((line) => line.split(";")[0] as string)
		.filter((pair) => !pair.endsWith("="))
		.join("; ");

const ada = (id = "p-ada"): Visitor => ({
	principal: { id, displayName: "Ada", disabled: false },
	tier: "member",
	speakerId: "idp:u-1",
	roles: [],
});

describeDb("signing in with an OpenID Connect provider", () => {
	let sql: SQL;
	let clock: number;
	let sessions: WebSessions;
	beforeAll(async () => {
		sql = new SQL(testDatabaseUrl, { max: 4 });
		await WebSessions.migration.up(sql);
	});
	afterAll(async () => {
		await sql`DELETE FROM web_sessions`;
		await sql.close();
	});
	beforeEach(async () => {
		await sql`DELETE FROM web_sessions`;
		clock = Date.parse("2026-10-01T00:00:00Z");
		sessions = new WebSessions(sql, { days: 30, now: () => clock });
	});

	const count = async (): Promise<number> => {
		const rows = (await sql`SELECT count(*)::int AS n FROM web_sessions`) as {
			n: number;
		}[];
		return rows[0]?.n ?? 0;
	};

	async function setup(
		over: Partial<ResolvedOidc> = {},
		admit: (actor: ActorFacts) => Identified = () => ({ visitor: ada() }),
	) {
		const idp = await provider();
		const signedIn: SignedIn[] = [];
		const ended: string[] = [];
		const identified: ActorFacts[] = [];
		const logs = recordingLogger();
		const login = new OidcLogin({
			settings: settings(over),
			metadata: {
				authorizationEndpoint: `${ISSUER}/authorize`,
				tokenEndpoint: `${ISSUER}/token`,
				jwksUri: `${ISSUER}/jwks`,
			},
			sessions,
			key: Buffer.alloc(32, 7),
			origin: ORIGIN,
			mount: MOUNT,
			surface: "app",
			routing: "hash",
			title: "Console",
			identify: async (actor) => {
				identified.push(actor);
				return admit(actor);
			},
			onSignIn: (info) => void signedIn.push(info),
			onEnded: (id) => void ended.push(id),
			...(over.onSessionVerified
				? { onSessionVerified: over.onSessionVerified }
				: {}),
			logger: logs.logger,
			keys: idp.keys,
			fetch: idp.fetcher,
			now: () => clock,
		});
		const get = async (path: string, cookie = "") => {
			const answer = await login.open(
				new Request(`${ORIGIN}${MOUNT}/${path}`, {
					headers: cookie ? { cookie } : {},
				}),
				path.split("?")[0] as string,
			);
			if (!answer) throw new Error(`${path} was not answered`);
			return answer;
		};
		/** Runs a whole sign-in and returns the callback's answer. */
		const signIn = async (next?: string, cookie = "") => {
			const start = await get(`login${next ? `?next=${next}` : ""}`, cookie);
			const location = start.headers.get("location") as string;
			const code = idp.authorize(location);
			const state = new URL(location).searchParams.get("state");
			return {
				start,
				location,
				state,
				callback: await get(
					`auth/callback?code=${code}&state=${state}`,
					`${cookiesOf(start)}${cookie ? `; ${cookie}` : ""}`,
				),
			};
		};
		return { idp, login, get, signIn, signedIn, ended, identified, logs };
	}

	test("the code and PKCE flow makes a session whose cookie admits the next requests without the provider", async () => {
		const t = await setup();
		const { start, location, callback } = await t.signIn();
		const url = new URL(location);
		expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("redirect_uri")).toBe(
			`${ORIGIN}${MOUNT}/auth/callback`,
		);
		// The first visit asks the provider silently, so a live single sign-on needs no click.
		expect(url.searchParams.get("prompt")).toBe("none");
		expect(start.headers.get("set-cookie")).toContain("HttpOnly");
		expect(callback.status).toBe(303);
		expect(callback.headers.get("location")).toBe(`${MOUNT}/`);
		const n = await count();
		expect(n).toBe(1);
		expect(t.signedIn).toEqual([
			{
				principalId: "p-ada",
				speakerId: "idp:u-1",
				provider: expect.any(String),
				name: "Ada",
			} as never,
		]);
		const cookie = cookiesOf(callback);
		const credential = await t.login.credential(
			new Request(`${ORIGIN}${MOUNT}/api/session`, {
				headers: { cookie },
			}),
		);
		expect(credential).toMatchObject({
			admitted: true,
			actor: { subject: "u-1", name: "Ada", roles: ["app:role:staff"] },
		});
		// The provider's own answers are not asked again.
		expect(t.identified).toHaveLength(1);
	});

	test("the signed-out page names the round-table mark as its icon and lets the page load it", async () => {
		const { get } = await setup();
		const page = await get("auth/signed-out");
		expect(page.status).toBe(200);
		expect(page.headers.get("content-security-policy")).toContain(
			"img-src 'self'",
		);
		expect(await page.text()).toContain(
			`<link rel="icon" href="${MOUNT}/icons/192.png" type="image/png">`,
		);
	});

	test("a login_required answer to the silent request leads to one interactive retry", async () => {
		const t = await setup();
		const start = await t.get("login");
		const first = new URL(start.headers.get("location") as string);
		expect(first.searchParams.get("prompt")).toBe("none");
		const callback = await t.get(
			`auth/callback?error=login_required&state=${first.searchParams.get("state")}`,
			cookiesOf(start),
		);
		expect(callback.status).toBe(303);
		const retry = new URL(callback.headers.get("location") as string);
		expect(retry.pathname).toBe("/authorize");
		expect(retry.searchParams.has("prompt")).toBe(false);
		// The retry is one: a second refusal is a failed sign-in, not a loop.
		const again = await t.get(
			`auth/callback?error=login_required&state=${retry.searchParams.get("state")}`,
			cookiesOf(callback),
		);
		expect(again.status).toBe(400);
		expect(again.headers.get("location")).toBeNull();
	});

	test("a state mismatch, a replayed state and a callback with no pending cookie are refused", async () => {
		const t = await setup();
		const start = await t.get("login");
		const location = start.headers.get("location") as string;
		const code = t.idp.authorize(location);
		const pending = cookiesOf(start);
		const wrong = await t.get(
			`auth/callback?code=${code}&state=forged`,
			pending,
		);
		expect(wrong.status).toBe(400);
		const state = new URL(location).searchParams.get("state");
		const none = await t.get(`auth/callback?code=${code}&state=${state}`);
		expect(none.status).toBe(400);
		const good = await t.get(
			`auth/callback?code=${code}&state=${state}`,
			pending,
		);
		expect(good.status).toBe(303);
		const replay = await t.get(
			`auth/callback?code=${code}&state=${state}`,
			pending,
		);
		expect(replay.status).toBe(400);
		expect(t.signedIn).toHaveLength(1);
	});

	test("a token with another nonce, issuer or a missing subject makes no session", async () => {
		const t = await setup();
		t.idp.issue.nonce = () => "someone else's";
		expect((await t.signIn()).callback.status).toBe(400);
		t.idp.issue.nonce = (given) => given;
		t.idp.issue.issuer = "https://evil.example.test";
		expect((await t.signIn()).callback.status).toBe(400);
		t.idp.issue.issuer = ISSUER;
		t.idp.issue.claims = { name: "No subject" };
		expect((await t.signIn()).callback.status).toBe(400);
		const n = await count();
		expect(n).toBe(0);
	});

	test("a person the access rules refuse, or the host's check refuses, gets no session", async () => {
		const refused = await setup({}, () => ({ refusal: "no tier" }));
		const denied = (await refused.signIn()).callback;
		expect(denied.status).toBe(403);
		const checked = await setup({ check: (claims) => claims.hd === "corp" });
		expect((await checked.signIn()).callback.status).toBe(403);
		const n = await count();
		expect(n).toBe(0);
	});

	test("the session slides: day 29 keeps it, 30 idle days end it", async () => {
		const t = await setup();
		const cookie = cookiesOf((await t.signIn()).callback);
		const visit = () =>
			t.login.credential(
				new Request(`${ORIGIN}${MOUNT}/api/session`, { headers: { cookie } }),
			);
		clock += 29 * DAY;
		expect(await visit()).toMatchObject({ admitted: true });
		// The visit on day 29 moved the limit: day 58 is within 30 days of it.
		clock += 29 * DAY;
		expect(await visit()).toMatchObject({ admitted: true });
		clock += 30 * DAY + 1000;
		expect(await visit()).toMatchObject({ status: 401, login: true });
	});

	test("logout deletes the row, so the old cookie is refused afterwards, and needs this origin", async () => {
		const t = await setup();
		const cookie = cookiesOf((await t.signIn()).callback);
		const bare = new Request(`${ORIGIN}${MOUNT}/auth/logout`, {
			method: "POST",
			headers: { cookie },
		});
		expect((await t.login.open(bare, "auth/logout"))?.status).toBe(403);
		const out = await t.login.open(
			new Request(`${ORIGIN}${MOUNT}/auth/logout`, {
				method: "POST",
				headers: { cookie, origin: ORIGIN },
			}),
			"auth/logout",
		);
		expect(out?.status).toBe(303);
		expect(t.ended).toHaveLength(1);
		const after = await t.login.credential(
			new Request(`${ORIGIN}${MOUNT}/api/session`, { headers: { cookie } }),
		);
		expect(after).toMatchObject({ status: 401, login: true });
		// The next sign-in is a deliberate one: no silent round trip first.
		const next = await t.get("login", cookiesOf(out as Response));
		expect(
			new URL(next.headers.get("location") as string).searchParams.has(
				"prompt",
			),
		).toBe(false);
	});

	test("?next keeps a page of the app and drops anything else", async () => {
		const t = await setup();
		const room = await t.signIn("room:app:thread.abc");
		expect(room.callback.headers.get("location")).toBe(
			`${MOUNT}/#/room/${encodeURIComponent("app:thread.abc")}`,
		);
		const page = await t.signIn("p:crm-case");
		expect(page.callback.headers.get("location")).toBe(`${MOUNT}/#/p/crm-case`);
		for (const hostile of [
			"https://evil.example.test/",
			"//evil.example.test",
			"/\\evil.example.test",
			"room:other:agent.x",
			"p:a/../b",
		]) {
			const dropped = await t.signIn(encodeURIComponent(hostile));
			expect(dropped.callback.headers.get("location")).toBe(`${MOUNT}/`);
		}
	});

	test("a session past reauthHours must go through the provider again, and the new sign-in replaces it", async () => {
		const t = await setup({ reauthHours: 12 });
		const first = (await t.signIn()).callback;
		const cookie = cookiesOf(first);
		const visit = (header: string) =>
			t.login.credential(
				new Request(`${ORIGIN}${MOUNT}/api/session`, {
					headers: { cookie: header },
				}),
			);
		clock += 11 * 3_600_000;
		expect(await visit(cookie)).toMatchObject({ admitted: true });
		clock += 2 * 3_600_000;
		expect(await visit(cookie)).toMatchObject({ status: 401, login: true });
		// The silent round trip signs in again, makes a session with a fresh verification time and ends the old one.
		t.idp.issue.claims = { sub: "u-1", name: "Ada", roles: ["lead"] };
		const again = (await t.signIn(undefined, cookie)).callback;
		const fresh = cookiesOf(again);
		expect(await visit(fresh)).toMatchObject({
			admitted: true,
			actor: { roles: ["app:role:lead"] },
		});
		expect(await visit(cookie)).toMatchObject({ status: 401 });
		// A provider that answers login_required turns it into a normal sign-in.
		const start = await t.get("login", `${fresh}`);
		expect(
			new URL(start.headers.get("location") as string).searchParams.get(
				"prompt",
			),
		).toBe("none");
	});

	test("an open socket's recheck applies reauthHours as a request does", async () => {
		const t = await setup({ reauthHours: 12 });
		const cookie = cookiesOf((await t.signIn()).callback);
		const credential = await t.login.credential(
			new Request(`${ORIGIN}${MOUNT}/api/session`, {
				headers: { cookie },
			}),
		);
		const id = (credential as { session: string }).session;
		const liveId = async () => id;
		expect(await sessions.alive(await liveId(), 12)).toBe(true);
		clock += 11 * 3_600_000;
		expect(await sessions.alive(await liveId(), 12)).toBe(true);
		clock += 2 * 3_600_000;
		// The session itself is far from its idle limit, yet the provider's word has lapsed.
		expect(await sessions.alive(await liveId(), 12)).toBe(false);
		expect(await sessions.alive(await liveId())).toBe(true);
	});

	test("storeClaims keeps only the named claims, replaced at each sign-in, and never logs them", async () => {
		const t = await setup({ storeClaims: ["email"] });
		t.idp.issue.claims = {
			sub: "u-1",
			name: "Ada",
			email: "ada@example.test",
			secret: "do-not-keep",
		};
		await t.signIn();
		expect(await sessions.claimsOf("p-ada")).toEqual({
			email: "ada@example.test",
		});
		t.idp.issue.claims = { sub: "u-1", name: "Ada", email: "new@example.test" };
		clock += 1000;
		await t.signIn();
		expect(await sessions.claimsOf("p-ada")).toEqual({
			email: "new@example.test",
		});
		expect(JSON.stringify(t.logs.lines)).not.toContain("example.test");
		const plain = await setup();
		await plain.signIn();
		expect(await sessions.claimsOf("p-nobody")).toBeUndefined();
	});

	test("the session store never keeps the cookie's id, and sweeps what lapsed", async () => {
		const t = await setup();
		const cookie = cookiesOf((await t.signIn()).callback);
		const token = cookie.split("=")[1] as string;
		const rows =
			(await sql`SELECT encode(id_hash, 'hex') AS id FROM web_sessions`) as {
				id: string;
			}[];
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe(createHash("sha256").update(token).digest("hex"));
		clock += 31 * DAY;
		expect(await sessions.sweep()).toBe(1);
	});
	test("onSessionVerified hears a live session at most once every five minutes, and a hook that fails is logged, not thrown", async () => {
		const heard: string[] = [];
		const t = await setup({
			onSessionVerified: (id) => {
				heard.push(id);
				if (heard.length === 2) throw new Error("hook broke");
			},
		});
		t.login.verified("s-1", "p-ada");
		t.login.verified("s-1", "p-ada");
		t.login.verified("s-2", "p-bea");
		expect(heard).toEqual(["p-ada", "p-bea"]);
		clock += 299_000;
		t.login.verified("s-1", "p-ada");
		expect(heard).toHaveLength(2);
		clock += 2_000;
		t.login.verified("s-1", "p-ada");
		expect(heard).toEqual(["p-ada", "p-bea", "p-ada"]);
		await Bun.sleep(5);
		expect(JSON.stringify(t.logs.lines)).toContain("session-verified hook");
	});

	test("a hook that rejects is logged and a login with no hook ignores the report", async () => {
		const t = await setup({
			onSessionVerified: () => Promise.reject(new Error("later")),
		});
		t.login.verified("s-1", "p-ada");
		await Bun.sleep(5);
		expect(JSON.stringify(t.logs.lines)).toContain("session-verified hook");
		const plain = await setup();
		expect(() => plain.login.verified("s-1", "p-ada")).not.toThrow();
	});
});
