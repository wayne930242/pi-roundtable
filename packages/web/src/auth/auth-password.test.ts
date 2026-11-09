import { describe, expect, test } from "bun:test";
import {
	build,
	cookieOf,
	HTTP_ORIGIN,
	HTTPS_ORIGIN,
	login,
	OTHER_PASSWORD,
	OWNER,
	PASSWORD,
	password,
	removeAuthDirsAfterEach,
	request,
	START,
	signedIn,
	withCookie,
} from "../testing/auth-harness.ts";
import { WEB_CONSOLE_ACTOR } from "./authenticator.ts";

removeAuthDirsAfterEach();

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

	test("the login page names the round-table mark as its icon, and the icon and the manifest need no session", async () => {
		const { server } = build({ auth: password() });
		const page = await server.handle(request("/console/login"));
		expect(page.headers.get("content-security-policy")).toContain(
			"img-src 'self'",
		);
		const html = await page.text();
		expect(html).toContain(
			'<link rel="icon" href="/console/icons/192.png" type="image/png">',
		);
		for (const path of [
			"icons/192.png",
			"icons/512.png",
			"manifest.webmanifest",
		])
			expect({
				path,
				status: (await server.handle(request(`/console/${path}`))).status,
			}).toEqual({ path, status: 200 });
		// Only those: the page, the worker and any other name still need the session.
		for (const path of [
			"",
			"sw.js",
			"icons/nope.png",
			"icons/a.txt",
			"assets/app.js",
		])
			expect({
				path,
				status: (await server.handle(request(`/console/${path}`))).status,
			}).toEqual({ path, status: 303 });
		expect(
			(
				await server.handle(
					request("/console/icons/192.png", { method: "DELETE" }),
				)
			).status,
		).toBe(401);
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
		// The first character carries six signature bits; the last one's low bits are padding.
		const flipped = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
		// Same bytes, other spelling: the last character's unused bits set.
		const alphabet =
			"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
		const last = alphabet.indexOf(signature.slice(-1));
		const respelled = `${signature.slice(0, -1)}${alphabet[last ^ 1]}`;
		expect(Buffer.from(respelled, "base64url")).toEqual(
			Buffer.from(signature, "base64url"),
		);
		for (const bad of [
			`${payload}.${flipped}`,
			`${payload}.${respelled}`,
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
