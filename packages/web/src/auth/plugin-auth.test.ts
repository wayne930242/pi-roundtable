import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDENTITY } from "pi-roundtable";
import {
	servicePair,
	type TestPluginResult,
	testPlugin,
} from "pi-roundtable/testing";
import { fakeIdentity, fixtureSessions, ORIGIN } from "../testing/fixtures.ts";
import { admit } from "../verifier.ts";
import { webConsole } from "../web-plugin.ts";

const PASSWORD = "plugin level secret";
const ENV = "ROUNDTABLE_WEB_PASSWORD_TEST";

const harnesses: TestPluginResult[] = [];
afterEach(async () => {
	delete process.env[ENV];
	await Promise.all(harnesses.splice(0).map((harness) => harness.stop()));
});

/** The page stand-in and an owner linked to the web console's own plugin identity. */
const base = () => {
	const assetDir = mkdtempSync(join(tmpdir(), "web-auth-page-"));
	writeFileSync(join(assetDir, "index.html"), "<html>console</html>");
	return {
		origin: ORIGIN,
		dataDir: fixtureSessions(),
		assetDir,
		panes: ["conversations" as const],
	};
};
const people = servicePair(
	IDENTITY,
	fakeIdentity([
		{
			id: "owner",
			name: "Owner",
			tier: "owner",
			identities: ["token:web-console"],
		},
	]),
);

async function boot(
	options: Parameters<typeof webConsole>[0],
	listeners: NonNullable<Parameters<typeof testPlugin>[1]>["listeners"],
) {
	const harness = await testPlugin(webConsole(options), {
		services: [people],
		listeners,
	});
	harnesses.push(harness);
	const route = harness.contribution.http?.find(
		(candidate) => candidate.name === "web-console",
	);
	if (!route) throw new Error("no route");
	return {
		harness,
		call: (path: string, init: RequestInit = {}) =>
			route.handle(new Request(`http://host${path}`, init)),
	};
}

const unix = [{ id: "public", socketPath: "/tmp/web-console.sock" }];

describe("webConsole auth", () => {
	test("none and password declare the plugin identity, with the principal they speak for; a verifier declares none", () => {
		expect(
			webConsole({ ...base(), auth: { mode: "none" } }).identities,
		).toEqual([{ identity: "token:web-console" }]);
		expect(
			webConsole({
				...base(),
				auth: { mode: "password", principal: "p_owner" },
			}).identities,
		).toEqual([{ identity: "token:web-console", principal: "p_owner" }]);
		expect(
			webConsole({ ...base(), verifier: () => admit() }).identities,
		).toBeUndefined();
		expect(
			webConsole({
				...base(),
				auth: { mode: "verifier", verifier: () => admit() },
			}).identities,
		).toBeUndefined();
	});

	test("none on a TCP listener with no hostname stops the host's setup", async () => {
		await expect(
			testPlugin(webConsole({ ...base(), auth: { mode: "none" } }), {
				services: [people],
				listeners: [{ id: "public", port: 8080 }],
			}),
		).rejects.toThrow(/trustNetwork/);
	});

	test("none on loopback or a unix socket serves the console as the owner", async () => {
		for (const listeners of [
			unix,
			[{ id: "public", port: 8080, hostname: "127.0.0.1" }],
		]) {
			const { call } = await boot(
				{ ...base(), auth: { mode: "none" } },
				listeners,
			);
			const response = await call("/console/api/config");
			expect(response.status).toBe(200);
		}
	});

	test("none follows the listener option", async () => {
		await expect(
			testPlugin(
				webConsole({ ...base(), auth: { mode: "none" }, listener: "admin" }),
				{ services: [people], listeners: [{ id: "public", port: 80 }] },
			),
		).rejects.toThrow(/listener admin/);
		const { call } = await boot(
			{ ...base(), auth: { mode: "none" }, listener: "admin" },
			[{ id: "admin", socketPath: "/tmp/admin.sock" }],
		);
		expect((await call("/console/api/config")).status).toBe(200);
	});

	test("password logs in through the plugin's route and keeps its session key in the data directory", async () => {
		process.env[ENV] = PASSWORD;
		const options = base();
		const { call } = await boot(
			{ ...options, auth: { mode: "password", passwordEnv: ENV } },
			unix,
		);
		expect((await call("/console/api/config")).status).toBe(401);
		const login = await call("/console/auth/login", {
			method: "POST",
			headers: {
				origin: ORIGIN,
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ password: PASSWORD }).toString(),
		});
		expect(login.status).toBe(303);
		const cookie = login.headers.getSetCookie()[0]?.split(";")[0] ?? "";
		const response = await call("/console/api/config", {
			headers: { cookie },
		});
		expect(response.status).toBe(200);
		expect(
			statSync(join(options.dataDir, "web", "session.key")).mode & 0o777,
		).toBe(0o600);
	});

	test("password with the variable unset stops the host's setup, naming the variable", async () => {
		await expect(
			testPlugin(
				webConsole({
					...base(),
					auth: { mode: "password", passwordEnv: ENV },
				}),
				{ services: [people], listeners: unix },
			),
		).rejects.toThrow(ENV);
	});
});
