import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REST } from "discord.js";
import { serviceKey } from "./contract/services.ts";
import { defineRoundtable } from "./define-roundtable.ts";
import { Roundtable, type RoundtableOptions } from "./host.ts";
import type { HttpRoute } from "./http/listeners.ts";
import type { AccessRules } from "./identity/access-policy.ts";
import { identityPlugin } from "./identity/identity-plugin.ts";
import { silentLogger } from "./log.ts";
import type { RoundtablePlugin, Service } from "./plugin.ts";

const MISSING = serviceKey<{ x: number }>("host-check.missing");

const dir = mkdtempSync(join(tmpdir(), "roundtable-host-check-"));
const SOCKET = join(dir, "main.sock");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function options(extra: Partial<RoundtableOptions> = {}): RoundtableOptions {
	return {
		logger: silentLogger(),
		listeners: [{ id: "main", socketPath: SOCKET }],
		...extra,
	};
}

const service = (name: string, extra: Partial<Service> = {}): Service => ({
	name,
	...extra,
});

const route = (name: string, path: string): HttpRoute => ({
	name,
	listener: "main",
	path: { exact: path },
	handle: () => new Response("ok"),
});

const hosts: Roundtable[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.shutdown("test");
});

/** Plugins a host refuses before anything starts, each with what its refusal says. */
const REFUSED: {
	label: string;
	plugins: RoundtablePlugin[];
	says: RegExp;
}[] = [
	{
		label: "a plugin that adds nothing",
		plugins: [{ name: "empty", setup: () => ({}) }],
		says: /plugin empty adds nothing\. Give it a part/,
	},
	{
		label: "two services of one name",
		plugins: [
			{ name: "a", setup: () => ({ services: [service("same")] }) },
			{ name: "b", setup: () => ({ services: [service("same")] }) },
		],
		says: /service "?same"?/,
	},
	{
		label: "a service that no plugin provides",
		plugins: [
			{
				name: "reader",
				requires: [MISSING],
				setup: () => ({ services: [service("reader")] }),
			},
		],
		says: /host-check\.missing/,
	},
	{
		label: "a field the host removed",
		plugins: [
			{
				name: "old",
				useCommands: [],
				setup: () => ({ services: [service("old")] }),
			} as unknown as RoundtablePlugin,
		],
		says: /plugin old: "useCommands" was removed in 0\.2\.0/,
	},
	{
		label: "two routes that answer one request",
		plugins: [
			{ name: "a", setup: () => ({ http: [route("one", "/same")] }) },
			{ name: "b", setup: () => ({ http: [route("two", "/same")] }) },
		],
		says: /routes one and two overlap on listener main/,
	},
	{
		label: "a route on a listener that is not configured",
		plugins: [
			{
				name: "lost",
				setup: () => ({
					http: [{ ...route("lost", "/x"), listener: "nowhere" }],
				}),
			},
		],
		says: /nowhere/,
	},
	{
		label: "a plugin whose setup throws",
		plugins: [
			{
				name: "broken",
				setup: () => {
					throw new Error("cannot open the thing");
				},
			},
		],
		says: /plugin broken: setup failed: cannot open the thing/,
	},
];

describe("Roundtable.check", () => {
	test.each(REFUSED)(
		"refuses $label with the message run() refuses it with",
		async ({ plugins, says }) => {
			const checked = await new Roundtable(options(), plugins).check().then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(checked).toBeInstanceOf(Error);
			const message = (checked as Error).message;
			expect(message).toMatch(says);
			const ran = new Roundtable(options(), plugins);
			hosts.push(ran);
			await expect(ran.run()).rejects.toThrow(message);
		},
	);

	test("reports the plugins that run, the services they add in start order, and the routes", async () => {
		const report = await new Roundtable(options(), [
			{
				name: "first",
				setup: () => ({
					services: [service("one"), service("two")],
					http: [route("r", "/first")],
				}),
			},
			{ name: "second", setup: () => ({ services: [service("three")] }) },
		]).check();
		expect(report).toEqual({
			plugins: ["first", "second"],
			services: ["one", "two", "three"],
			routes: ["main /first"],
		});
	});

	test("starts nothing, opens no listener and runs no preflight, and the host can run afterwards", async () => {
		const log: string[] = [];
		const plugins: RoundtablePlugin[] = [
			{
				name: "p",
				preflight: () => {
					log.push("preflight");
				},
				setup: () => ({
					services: [
						service("s", {
							start: () => {
								log.push("start");
							},
							stop: () => {
								log.push("stop");
							},
						}),
					],
					http: [route("r", "/p")],
				}),
			},
		];
		const host = new Roundtable(options(), plugins);
		hosts.push(host);
		await host.check();
		expect(log).toEqual([]);
		expect(existsSync(SOCKET)).toBe(false);
		await host.run();
		expect(log).toEqual(["preflight", "start"]);
		expect(existsSync(SOCKET)).toBe(true);
	});

	test("is no running host: it checks while another host runs, and run() still refuses a second host", async () => {
		const plugins: RoundtablePlugin[] = [
			{ name: "p", setup: () => ({ services: [service("s")] }) },
		];
		const first = new Roundtable(options({ listeners: [] }), plugins);
		hosts.push(first);
		await first.run();
		const second = new Roundtable(options({ listeners: [] }), plugins);
		await expect(second.check()).resolves.toMatchObject({ plugins: ["p"] });
		await expect(second.run()).rejects.toThrow(
			"a Roundtable host is already running in this process",
		);
	});

	test("refuses a plugin that queries the database during setup, naming it and where to query from", async () => {
		const plugin: RoundtablePlugin = {
			name: "eager",
			setup: async ({ database }) => {
				await database()`SELECT 1`;
				return { services: [service("eager")] };
			},
		};
		const message = await new Roundtable(options(), [plugin]).check().then(
			() => "",
			(error: Error) => error.message,
		);
		expect(message).toContain("plugin eager: setup failed");
		expect(message).toContain("query from a service's start");
	});

	test("lets a plugin take the database in setup and query it from a service's start", async () => {
		const plugin: RoundtablePlugin = {
			name: "lazy",
			setup: ({ database }) => {
				const sql = database();
				return {
					services: [
						service("lazy", {
							start: async () => {
								await sql`SELECT 1`;
							},
						}),
					],
				};
			},
		};
		await expect(
			new Roundtable(options(), [plugin]).check(),
		).resolves.toMatchObject({ services: ["lazy"] });
	});

	test("passes a configuration without agents, as 0.14.0's seeds plugin broke one", async () => {
		const defined = await defineRoundtable(
			{
				owner: { id: "100000000000000001", name: "Ada" },
				discord: {
					token: "token",
					guild: "900000000000000001",
					entryChannel: "900000000000000002",
				},
				database: { url: "postgres://unused@127.0.0.1:1/none" },
				dataDir: dir,
				model: "anthropic/claude-sonnet-5-5",
				http: { publicUrl: "https://bot.example.com", socketPath: SOCKET },
			},
			{ logger: silentLogger() },
		);
		const report = await new Roundtable(
			defined.options,
			defined.plugins,
		).check();
		expect(report.plugins).toContain("identity");
		expect(report.plugins).toContain("runtime");
		expect(existsSync(SOCKET)).toBe(false);
	});

	test("the Discord plugin's poster sends nothing while the host checks its configuration", async () => {
		const request = spyOn(REST.prototype, "request");
		try {
			const defined = await defineRoundtable(
				{
					owner: { id: "100000000000000001", name: "Ada" },
					discord: {
						token: "token",
						guild: "900000000000000001",
						entryChannel: "900000000000000002",
					},
					database: { url: "postgres://unused@127.0.0.1:1/none" },
					dataDir: dir,
					model: "anthropic/claude-sonnet-5-5",
					http: { publicUrl: "https://bot.example.com", socketPath: SOCKET },
				},
				{ logger: silentLogger() },
			);
			await new Roundtable(defined.options, defined.plugins).check();
			expect(request).not.toHaveBeenCalled();
		} finally {
			request.mockRestore();
		}
	});

	describe("the configured identities, which the check settles without a stored principal", () => {
		const ADA = "966666600000000001";
		const BO = "966666600000000002";
		const rules = (
			...owners: AccessRules["owners"][number][]
		): AccessRules => ({
			owners,
			members: {},
			provisioning: "admitted",
			backgroundStaleDays: 30,
		});
		const declaring = (principal?: string): RoundtablePlugin => ({
			name: "remote",
			identities: [
				{ identity: "token:remote", ...(principal ? { principal } : {}) },
			],
			setup: () => ({ services: [service("remote")] }),
		});
		const checked = async (access: AccessRules, declares: RoundtablePlugin) =>
			new Roundtable(options(), [
				identityPlugin({ rules: access, plugins: [declares] }),
				declares,
			])
				.check()
				.then(
					() => "",
					(error: Error) => error.message,
				);

		test("passes a plugin identity bound to a configured owner", async () => {
			const ada = { name: "Ada", principal: ADA, identities: [] };
			expect(await checked(rules(ada), declaring())).toBe("");
			expect(await checked(rules(ada), declaring(ADA))).toBe("");
		});

		test("refuses an identity that names no principal when no owner is listed to bind it to", async () => {
			expect(await checked(rules(), declaring())).toContain(
				"plugin remote: token:remote names no principal, and access.owners lists no primary owner",
			);
		});

		test("refuses an owner who lists an identity a plugin binds to another principal", async () => {
			const ada = { name: "Ada", principal: ADA, identities: [] };
			const bo = {
				name: "Bo",
				principal: BO,
				identities: ["token:remote"],
			};
			expect(await checked(rules(ada, bo), declaring())).toContain(
				`config access.owners[1].identities[0]: token:remote is an identity plugin remote declares, bound to principal ${ADA}, not to this owner's ${BO}`,
			);
		});

		test("leaves to the start what a stored link would settle", async () => {
			const ada = { name: "Ada", principal: ADA, identities: [] };
			const bo = { name: "Bo", identities: ["token:remote"] };
			expect(await checked(rules(ada, bo), declaring(BO))).toBe("");
		});
	});
});
