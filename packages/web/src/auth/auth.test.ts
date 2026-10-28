import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActorFacts, ListenerAddress } from "pi-roundtable";
import { PluginError } from "pi-roundtable";
import { recordingLogger } from "pi-roundtable/testing";
import type { AssetBundle } from "../assets.ts";
import { ConsoleServer } from "../console-server.ts";
import { resolveOptions } from "../options.ts";
import { admit, admitAs, refuse } from "../verifier.ts";
import type { Identified, Visitor } from "../visitors.ts";
import {
	type Authenticator,
	type AuthenticatorOptions,
	createAuthenticator,
	WEB_CONSOLE_ACTOR,
} from "./authenticator.ts";

const OWNER: Visitor = {
	principal: { id: "owner", displayName: "Owner", disabled: false },
};
const HTTP_ORIGIN = "http://console.example.test";
const HTTPS_ORIGIN = "https://console.example.test";
const PASSWORD = "correct horse battery";
const OTHER_PASSWORD = "another long secret";
const START = Date.parse("2026-10-28T00:00:00Z");

const assets: AssetBundle = new Map([
	[
		"index.html",
		{ body: Buffer.from("<html>console</html>"), type: "text/html" },
	],
]);

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});
const tempDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "web-auth-"));
	dirs.push(dir);
	return dir;
};

/** The identify step of a host whose only owner is linked to the web console's own identity. */
const identifyConsole = async (
	actor: ActorFacts | undefined,
): Promise<Identified> =>
	actor?.provider === "token" && actor.subject === "web-console"
		? { visitor: OWNER }
		: { refusal: "no such identity" };

const loopback: ListenerAddress = { port: 8080, hostname: "127.0.0.1" };

interface Harness {
	authenticator: Authenticator;
	server: ConsoleServer;
	recorder: ReturnType<typeof recordingLogger>;
	apiPaths: string[];
	clock: { now: number };
	dataDir: string;
}

function build(
	options: Partial<AuthenticatorOptions> & Pick<AuthenticatorOptions, "auth">,
	extra: { clock?: { now: number }; dataDir?: string } = {},
): Harness {
	const recorder = recordingLogger();
	const clock = extra.clock ?? { now: START };
	const dataDir = extra.dataDir ?? tempDir();
	const authenticator = createAuthenticator({
		identify: identifyConsole,
		origin: HTTP_ORIGIN,
		mount: "/console",
		title: "Test console",
		logger: recorder.logger,
		dataDir,
		listener: { id: "public", address: loopback },
		env: { ROUNDTABLE_WEB_PASSWORD: PASSWORD },
		loginDelayMs: 0,
		now: () => clock.now,
		...options,
	});
	const apiPaths: string[] = [];
	const server = new ConsoleServer({
		mount: "/console",
		assets,
		authenticator,
		api: {
			handle: async (_request, path) => {
				apiPaths.push(path);
				return Response.json({ ok: true });
			},
		},
		subscribe: () => undefined,
		logger: recorder.logger,
	});
	return { authenticator, server, recorder, apiPaths, clock, dataDir };
}

const password = (auth: Partial<{ sessionDays: number }> = {}) => ({
	mode: "password" as const,
	passwordEnv: "ROUNDTABLE_WEB_PASSWORD",
	sessionDays: 30,
	...auth,
});
const none = (trustNetwork = false) => ({
	mode: "none" as const,
	trustNetwork,
});

const request = (path: string, init: RequestInit = {}) =>
	new Request(`http://host${path}`, init);

const login = (
	server: ConsoleServer,
	given: string | undefined,
	headers: Record<string, string> = { origin: HTTP_ORIGIN },
) =>
	server.handle(
		request("/console/auth/login", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				...headers,
			},
			body: new URLSearchParams(
				given === undefined ? {} : { password: given },
			).toString(),
		}),
	);

/** The `name=value` pair of the session cookie a response sets. */
const cookieOf = (response: Response): string => {
	const set = response.headers.getSetCookie()[0];
	if (!set) throw new Error("no cookie set");
	return set.split(";")[0] ?? "";
};

const withCookie = (cookie: string, init: RequestInit = {}): RequestInit => ({
	...init,
	headers: { ...(init.headers as Record<string, string>), cookie },
});

async function signedIn(harness: Harness): Promise<string> {
	return cookieOf(await login(harness.server, PASSWORD));
}

describe("auth none", () => {
	test("a TCP listener without a hostname throws, naming the fix", () => {
		expect(() =>
			build({
				auth: none(),
				listener: { id: "public", address: { port: 8080 } },
			}),
		).toThrow(PluginError);
		expect(() =>
			build({
				auth: none(),
				listener: { id: "public", address: { port: 8080 } },
			}),
		).toThrow(/trustNetwork/);
	});

	test("a TCP listener on a hostname that reaches beyond the machine throws", () => {
		for (const hostname of ["0.0.0.0", "192.168.1.5", "::", "example.test"])
			expect(() =>
				build({
					auth: none(),
					listener: { id: "public", address: { port: 8080, hostname } },
				}),
			).toThrow(PluginError);
	});

	test("loopback TCP passes, in each spelling", () => {
		for (const hostname of ["127.0.0.1", "::1", "localhost"])
			expect(() =>
				build({
					auth: none(),
					listener: { id: "public", address: { port: 8080, hostname } },
				}),
			).not.toThrow();
	});

	test("a unix socket passes", () => {
		expect(() =>
			build({
				auth: none(),
				listener: { id: "public", address: { socketPath: "/tmp/web.sock" } },
			}),
		).not.toThrow();
	});

	test("trustNetwork lets any TCP address pass", () => {
		for (const address of [{ port: 8080 }, { port: 8080, hostname: "0.0.0.0" }])
			expect(() =>
				build({
					auth: none(true),
					listener: { id: "public", address },
				}),
			).not.toThrow();
	});

	test("a listener the host does not have throws", () => {
		expect(() =>
			build({
				auth: none(),
				listener: { id: "public", address: undefined },
			}),
		).toThrow(/listener public/);
	});

	test("it warns at every start, and more when a unix socket is writable by others", () => {
		const first = build({ auth: none() });
		const second = build({ auth: none() });
		for (const { recorder } of [first, second])
			expect(
				recorder.lines.filter(
					(line) => line.level === "warn" && /auth.*none/i.test(line.message),
				),
			).toHaveLength(1);
		const open = build({
			auth: none(),
			listener: {
				id: "public",
				address: { socketPath: "/tmp/web.sock", mode: 0o666 },
			},
		});
		expect(
			open.recorder.lines.filter((line) => /writable/i.test(line.message)),
		).toHaveLength(1);
		const closed = build({
			auth: none(),
			listener: {
				id: "public",
				address: { socketPath: "/tmp/web.sock", mode: 0o660 },
			},
		});
		expect(
			closed.recorder.lines.filter((line) => /writable/i.test(line.message)),
		).toHaveLength(0);
	});

	test("every request is the primary owner's, through the plugin identity", async () => {
		const { authenticator, server, apiPaths } = build({ auth: none() });
		const result = await authenticator.authenticate(request("/console/"));
		expect(result).toEqual({ visitor: OWNER, actor: WEB_CONSOLE_ACTOR });
		expect(WEB_CONSOLE_ACTOR).toMatchObject({
			provider: "token",
			subject: "web-console",
		});
		expect((await server.handle(request("/console/api/config"))).status).toBe(
			200,
		);
		expect(apiPaths).toEqual(["config"]);
	});

	test("a write still needs the console's own Origin", async () => {
		const { server } = build({ auth: none() });
		const write = (origin?: string) =>
			server.handle(
				request("/console/api/notes", {
					method: "POST",
					...(origin ? { headers: { origin } } : {}),
				}),
			);
		expect((await write("https://evil.example")).status).toBe(403);
		expect((await write()).status).toBe(403);
		expect((await write(HTTP_ORIGIN)).status).toBe(200);
	});

	test("it opens no login routes", async () => {
		const { server } = build({ auth: none() });
		expect((await server.handle(request("/console/login"))).status).toBe(404);
	});
});

describe("auth password setup", () => {
	test("a secret shorter than 12 characters throws, without naming it", () => {
		const short = "123456789";
		let message = "";
		try {
			build({
				auth: password(),
				env: { ROUNDTABLE_WEB_PASSWORD: short },
			});
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toMatch(/at least 12/);
		expect(message).toContain("ROUNDTABLE_WEB_PASSWORD");
		expect(message).not.toContain(short);
	});

	test("an unset or empty variable throws", () => {
		for (const env of [{}, { ROUNDTABLE_WEB_PASSWORD: "" }])
			expect(() => build({ auth: password(), env })).toThrow(
				/ROUNDTABLE_WEB_PASSWORD/,
			);
	});

	test("exactly 12 characters pass, and the variable's name is the option's", () => {
		expect(() =>
			build({
				auth: password(),
				env: { ROUNDTABLE_WEB_PASSWORD: "123456789012" },
			}),
		).not.toThrow();
		expect(() =>
			build({
				auth: { ...password(), passwordEnv: "MY_SECRET" },
				env: { MY_SECRET: "a-long-enough-secret" },
			}),
		).not.toThrow();
	});

	test("it keeps a 32-byte session key in the data directory, private to its owner, and reuses it", async () => {
		const first = build({ auth: password() });
		const file = join(first.dataDir, "web", "session.key");
		expect(statSync(file).size).toBe(32);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		const cookie = await signedIn(first);
		const second = build({ auth: password() }, { dataDir: first.dataDir });
		expect(
			(
				await second.server.handle(
					request("/console/api/config", withCookie(cookie)),
				)
			).status,
		).toBe(200);
	});

	test("a key of the wrong size stops startup instead of being used", async () => {
		const first = build({ auth: password() });
		await Bun.write(join(first.dataDir, "web", "session.key"), "short");
		expect(() =>
			build({ auth: password() }, { dataDir: first.dataDir }),
		).toThrow(PluginError);
	});
});

describe("auth password login", () => {
	test("without a session, a navigation goes to the login page and the API answers 401", async () => {
		const { server, apiPaths } = build({ auth: password() });
		for (const path of ["/console", "/console/", "/console/skills"]) {
			const response = await server.handle(request(path));
			expect(response.status).toBe(303);
			expect(response.headers.get("location")).toBe("/console/login");
		}
		for (const path of ["/console/api/config", "/console/api/events"]) {
			const response = await server.handle(request(path));
			expect(response.status).toBe(401);
			expect(response.headers.get("location")).toBeNull();
		}
		expect(apiPaths).toEqual([]);
	});

	test("the login page is server-rendered HTML with a form, and no script", async () => {
		const { server } = build({ auth: password() });
		const response = await server.handle(request("/console/login"));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(response.headers.get("content-security-policy")).toContain(
			"frame-ancestors 'none'",
		);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const html = await response.text();
		expect(html).toContain('action="/console/auth/login"');
		expect(html).toContain('type="password"');
		expect(html).toContain("Test console");
		expect(html.toLowerCase()).not.toContain("<script");
	});

	test("only login and auth/login and auth/logout are public", async () => {
		const { server } = build({ auth: password() });
		expect((await server.handle(request("/console/login"))).status).toBe(200);
		expect((await server.handle(request("/console/auth/login"))).status).toBe(
			405,
		);
		expect((await server.handle(request("/console/index.html"))).status).toBe(
			303,
		);
		expect((await server.handle(request("/console/auth/other"))).status).toBe(
			303,
		);
	});

	test("a wrong password answers 401 after about a second, and never reaches data", async () => {
		const { apiPaths } = build({ auth: password() });
		const slow = build({ auth: password(), loginDelayMs: 1000 });
		const start = performance.now();
		const response = await login(slow.server, "wrong wrong wrong");
		const elapsed = performance.now() - start;
		expect(response.status).toBe(401);
		expect(elapsed).toBeGreaterThanOrEqual(900);
		expect(elapsed).toBeLessThan(4000);
		expect(response.headers.getSetCookie()).toEqual([]);
		expect(await response.text()).toContain("password");
		expect(apiPaths).toEqual([]);
	});

	test("a missing password is a failure too", async () => {
		const { server } = build({ auth: password() });
		expect((await login(server, undefined)).status).toBe(401);
		expect((await login(server, "")).status).toBe(401);
	});

	test("the 11th failure in the window answers 429 with Retry-After, the right password included", async () => {
		const { server, clock, recorder } = build({ auth: password() });
		for (let attempt = 0; attempt < 10; attempt++) {
			clock.now += 1000;
			expect((await login(server, `wrong password ${attempt}`)).status).toBe(
				401,
			);
		}
		const locked = await login(server, "wrong again please");
		expect(locked.status).toBe(429);
		const retry = Number(locked.headers.get("retry-after"));
		expect(retry).toBeGreaterThan(0);
		expect(retry).toBeLessThanOrEqual(15 * 60);
		const right = await login(server, PASSWORD);
		expect(right.status).toBe(429);
		expect(right.headers.getSetCookie()).toEqual([]);
		expect(
			recorder.lines.some((line) => JSON.stringify(line).includes(PASSWORD)),
		).toBe(false);
		// After the window the oldest failures have aged out.
		clock.now += 15 * 60 * 1000;
		expect((await login(server, PASSWORD)).status).toBe(303);
	});

	test("failures spread over more than the window never lock", async () => {
		const { server, clock } = build({ auth: password() });
		for (let attempt = 0; attempt < 30; attempt++) {
			clock.now += 2 * 60 * 1000;
			expect((await login(server, `wrong password ${attempt}`)).status).toBe(
				401,
			);
		}
		expect((await login(server, PASSWORD)).status).toBe(303);
	});

	test("the right password sets a private session cookie scoped to the mount and goes to the console", async () => {
		const { server } = build({ auth: password({ sessionDays: 7 }) });
		const response = await login(server, PASSWORD);
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/console/");
		const [set] = response.headers.getSetCookie();
		expect(set).toStartWith("rt_session=");
		expect(set).toContain("HttpOnly");
		expect(set).toContain("SameSite=Strict");
		expect(set).toContain("Path=/console/");
		expect(set).toContain(`Max-Age=${7 * 86400}`);
		expect(set).not.toContain("Secure");
		expect(set).not.toContain(PASSWORD);
	});

	test("the cookie is Secure when the console is served over https", async () => {
		const { server } = build({ auth: password(), origin: HTTPS_ORIGIN });
		const response = await login(server, PASSWORD, { origin: HTTPS_ORIGIN });
		expect(response.headers.getSetCookie()[0]).toContain("Secure");
	});

	test("the cookie admits the API, the page and the event stream", async () => {
		const harness = build({ auth: password() });
		const cookie = await signedIn(harness);
		for (const [path, status] of [
			["/console/api/config", 200],
			["/console/api/events", 200],
			["/console/", 200],
			["/console", 302],
		] as const) {
			const response = await harness.server.handle(
				request(path, withCookie(cookie)),
			);
			expect(response.status).toBe(status);
		}
		const authenticated = await harness.authenticator.authenticate(
			request("/console/api/config", withCookie(cookie)),
		);
		expect(authenticated).toMatchObject({
			visitor: OWNER,
			actor: WEB_CONSOLE_ACTOR,
		});
		expect(
			"expiresAt" in authenticated && authenticated.expiresAt?.getTime(),
		).toBe(START + 30 * 86400 * 1000);
	});

	test("a tampered cookie is refused: signature, payload, and garbage", async () => {
		const harness = build({ auth: password() });
		const cookie = await signedIn(harness);
		const value = cookie.slice("rt_session=".length);
		const [payload, signature] = value.split(".") as [string, string];
		const forged = Buffer.from(
			JSON.stringify({ p: "web-console", e: 9_999_999_999, v: 1 }),
		).toString("base64url");
		const flipped = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
		for (const bad of [
			`${payload}.${flipped}`,
			`${forged}.${signature}`,
			`${payload}.`,
			payload,
			"",
			"garbage.garbage",
			`${payload}.${signature}.extra`,
		]) {
			const response = await harness.server.handle(
				request("/console/api/config", withCookie(`rt_session=${bad}`)),
			);
			expect(response.status).toBe(401);
		}
		expect(harness.apiPaths).toEqual([]);
	});

	test("an expired cookie is refused", async () => {
		const harness = build({ auth: password({ sessionDays: 1 }) });
		const cookie = await signedIn(harness);
		harness.clock.now += 86400 * 1000 - 1000;
		expect(
			(
				await harness.server.handle(
					request("/console/api/config", withCookie(cookie)),
				)
			).status,
		).toBe(200);
		harness.clock.now += 2000;
		expect(
			(
				await harness.server.handle(
					request("/console/api/config", withCookie(cookie)),
				)
			).status,
		).toBe(401);
	});

	test("a cookie made before a password change is refused", async () => {
		const before = build({ auth: password() });
		const cookie = await signedIn(before);
		const after = build(
			{
				auth: password(),
				env: { ROUNDTABLE_WEB_PASSWORD: OTHER_PASSWORD },
			},
			{ dataDir: before.dataDir },
		);
		expect(
			(
				await after.server.handle(
					request("/console/api/config", withCookie(cookie)),
				)
			).status,
		).toBe(401);
		const fresh = await login(after.server, OTHER_PASSWORD);
		expect(fresh.status).toBe(303);
		expect(
			(
				await after.server.handle(
					request("/console/api/config", withCookie(cookieOf(fresh))),
				)
			).status,
		).toBe(200);
	});

	test("a cookie made with another host's session key is refused", async () => {
		const mine = build({ auth: password() });
		const theirs = build({ auth: password() });
		const cookie = await signedIn(theirs);
		expect(
			(
				await mine.server.handle(
					request("/console/api/config", withCookie(cookie)),
				)
			).status,
		).toBe(401);
	});

	test("logout clears the cookie and goes to the login page", async () => {
		const { server } = build({ auth: password() });
		const response = await server.handle(
			request("/console/auth/logout", {
				method: "POST",
				headers: { origin: HTTP_ORIGIN },
			}),
		);
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/console/login");
		const [set] = response.headers.getSetCookie();
		expect(set).toStartWith("rt_session=;");
		expect(set).toContain("Max-Age=0");
		expect(set).toContain("Path=/console/");
		expect(set).toContain("HttpOnly");
	});

	test("a cross-Origin or Origin-less login or logout POST answers 403 and counts as no attempt", async () => {
		const { server, clock } = build({ auth: password() });
		for (const headers of [
			{ origin: "https://evil.example" },
			{} as Record<string, string>,
		]) {
			const response = await login(server, PASSWORD, headers);
			expect(response.status).toBe(403);
			expect(response.headers.getSetCookie()).toEqual([]);
			expect(
				(
					await server.handle(
						request("/console/auth/logout", { method: "POST", headers }),
					)
				).status,
			).toBe(403);
		}
		// 403s must not use up the failure budget.
		for (let attempt = 0; attempt < 20; attempt++)
			await login(server, PASSWORD, { origin: "https://evil.example" });
		clock.now += 1000;
		expect((await login(server, PASSWORD)).status).toBe(303);
	});

	test("a write with a valid cookie from a foreign Origin is refused", async () => {
		const harness = build({ auth: password() });
		const cookie = await signedIn(harness);
		const write = (origin: string) =>
			harness.server.handle(
				request(
					"/console/api/notes",
					withCookie(cookie, { method: "POST", headers: { origin } }),
				),
			);
		expect((await write("https://evil.example")).status).toBe(403);
		expect((await write(HTTP_ORIGIN)).status).toBe(200);
	});

	test("a valid cookie whose principal is no owner is refused with 403", async () => {
		const harness = build({
			auth: password(),
			identify: async () => ({
				refusal: "principal owner holds no owner role",
			}),
		});
		const cookie = await signedIn(harness);
		expect(
			(
				await harness.server.handle(
					request("/console/api/config", withCookie(cookie)),
				)
			).status,
		).toBe(403);
	});

	test("an oversized login body is refused without being read whole", async () => {
		const { server } = build({ auth: password() });
		const response = await login(server, "x".repeat(64 * 1024));
		expect(response.status).toBe(413);
	});
});

describe("auth verifier", () => {
	test("admits as the verifier says, and carries the expiry it reports", async () => {
		const actor: ActorFacts = { provider: "test", subject: "a", name: "A" };
		const expiresAt = new Date(START + 3600_000);
		const seen: (ActorFacts | undefined)[] = [];
		const { authenticator } = build({
			auth: {
				mode: "verifier",
				verifier: () => ({ admitted: true, actor, expiresAt }),
			},
			identify: async (given) => {
				seen.push(given);
				return { visitor: OWNER };
			},
		});
		expect(await authenticator.authenticate(request("/console/"))).toEqual({
			visitor: OWNER,
			actor,
			expiresAt,
		});
		expect(seen).toEqual([actor]);
	});

	test("refuses with 403 when the verifier refuses, throws, or rejects, and never says why to the client", async () => {
		for (const verifier of [
			() => refuse("no assertion"),
			() => {
				throw new Error("keys unreachable");
			},
			async () => {
				throw new Error("keys unreachable");
			},
		]) {
			const { server, apiPaths } = build({
				auth: { mode: "verifier", verifier },
			});
			const response = await server.handle(request("/console/api/config"));
			expect(response.status).toBe(403);
			expect(await response.text()).toBe("Forbidden");
			expect(apiPaths).toEqual([]);
		}
	});

	test("a verdict with no actor is the primary owner's, and admitAs carries an expiry", async () => {
		const { authenticator } = build({
			auth: { mode: "verifier", verifier: () => admit() },
			identify: async (actor) =>
				actor === undefined ? { visitor: OWNER } : { refusal: "unexpected" },
		});
		expect(await authenticator.authenticate(request("/console/"))).toEqual({
			visitor: OWNER,
		});
		const actor: ActorFacts = { provider: "test", subject: "a", name: "A" };
		const expiresAt = new Date(START);
		expect(admitAs(actor, expiresAt)).toEqual({
			admitted: true,
			actor,
			expiresAt,
		});
		expect(admitAs(actor)).toEqual({ admitted: true, actor });
	});
});

describe("auth options", () => {
	const base = { origin: HTTP_ORIGIN };

	test("the verifier option is shorthand for auth verifier", () => {
		const verifier = () => admit();
		expect(resolveOptions({ ...base, verifier }).auth).toEqual({
			mode: "verifier",
			verifier,
		});
		expect(
			resolveOptions({ ...base, auth: { mode: "verifier", verifier } }).auth,
		).toEqual({ mode: "verifier", verifier });
	});

	test("giving both auth and verifier throws", () => {
		expect(() =>
			resolveOptions({
				...base,
				verifier: () => admit(),
				auth: { mode: "none" },
			}),
		).toThrow(/both/);
	});

	test("with neither, the plugin refuses to start", () => {
		expect(() => resolveOptions({ ...base })).toThrow(/auth/);
	});

	test("none and password take their defaults", () => {
		expect(resolveOptions({ ...base, auth: { mode: "none" } }).auth).toEqual({
			mode: "none",
			trustNetwork: false,
		});
		expect(
			resolveOptions({ ...base, auth: { mode: "password" } }).auth,
		).toEqual({
			mode: "password",
			passwordEnv: "ROUNDTABLE_WEB_PASSWORD",
			sessionDays: 30,
		});
		expect(
			resolveOptions({
				...base,
				auth: { mode: "none", principal: "owner" },
			}).auth,
		).toEqual({ mode: "none", trustNetwork: false, principal: "owner" });
	});

	test("bad settings throw before anything starts", () => {
		for (const auth of [
			{ mode: "magic" },
			{ mode: "password", sessionDays: 0 },
			{ mode: "password", sessionDays: 400 },
			{ mode: "password", sessionDays: 1.5 },
			{ mode: "password", passwordEnv: "" },
			{ mode: "none", principal: " " },
			{ mode: "none", trustNetwork: "yes" },
			{ mode: "verifier" },
		])
			expect(() => resolveOptions({ ...base, auth: auth as never })).toThrow(
				PluginError,
			);
	});
});
