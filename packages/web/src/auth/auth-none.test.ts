import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { PluginError } from "pi-roundtable";
import {
	build,
	HTTP_ORIGIN,
	none,
	OWNER,
	password,
	removeAuthDirsAfterEach,
	request,
	signedIn,
	withCookie,
} from "../testing/auth-harness.ts";
import { WEB_CONSOLE_ACTOR } from "./authenticator.ts";

removeAuthDirsAfterEach();

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
