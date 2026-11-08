import { afterAll, afterEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { definePlugin, migrateDatabase } from "pi-roundtable";
import {
	describeDb,
	type TestHost,
	testDatabaseUrl,
	testHost,
} from "pi-roundtable/testing";
import { fakeContextForge } from "../testing/fake-contextforge.ts";
import { fakeInteraction } from "../testing/fake-interaction.ts";
import { CONNECTOR_MODAL_ID } from "./connector-commands.ts";
import { DEFAULT_RESYNC_INTERVAL_MS } from "./connector-resync.ts";
import { CONNECTORS, mcpConnectors } from "./connectors-plugin.ts";
import { CONNECTOR_MESSAGES } from "./messages.ts";

const contextForge = (url: string) => ({
	url,
	jwtSecret: "secret",
	user: "admin@example.com",
});

test.each([
	["a URL that is not http(s)", { url: "ftp://cf" }],
	["an empty secret", { jwtSecret: "" }],
	["an empty user", { user: "" }],
])("refuses %s before the host starts", (_name, change) => {
	expect(() =>
		mcpConnectors({
			contextForge: { ...contextForge("http://cf"), ...change },
		}),
	).toThrow("mcp-connectors");
});

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("mcpConnectors on a host", () => {
	const cf = fakeContextForge();
	// A process runs one host at a time.
	let running: TestHost | undefined;

	afterEach(async () => {
		await running?.stop();
		running = undefined;
	});

	afterAll(() => cf.stop());

	/** A host over a table with no connectors, so each test starts from the same state. */
	async function boot(
		options: Partial<Parameters<typeof mcpConnectors>[0]>,
		keepConnectors = false,
	) {
		const plugin = mcpConnectors({
			contextForge: contextForge(`${cf.url}/`),
			// Only the tests about pacing wait between requests.
			resyncIntervalMs: 0,
			...options,
		});
		await migrateDatabase(testDatabaseUrl, [plugin]);
		const sql = new SQL(testDatabaseUrl);
		if (!keepConnectors) await sql`DELETE FROM owner_connectors`;
		await sql.close();
		if (!keepConnectors) cf.reset();
		if (!keepConnectors)
			cf.upstream["https://mcp.example.test/mcp"] = ["search", "get-page"];
		running = await testHost({ plugins: [plugin] });
		return running;
	}

	/** Hands an interaction to the command modules in reverse order; the last one added is the plugin's. */
	async function handle(host: TestHost, interaction: never) {
		for (const { module } of host.commands.added.toReversed())
			if (await module.handle(interaction)) return;
		throw new Error("no command module took the interaction");
	}

	const addNotion = () =>
		fakeInteraction({
			group: "connector",
			sub: "add",
			modal: CONNECTOR_MODAL_ID,
			fields: {
				name: "notion",
				url: "https://mcp.example.test/mcp",
				description: "Pages in the owner's Notion",
				header: "",
				token: "secret-token",
			},
		});

	test("adds /<root> connector with its five subcommands", async () => {
		const host = await boot({});
		const root = host.commands
			.composed()
			.commands.find((command) => command.name === "roundtable");
		const group = root?.options?.find((option) => option.name === "connector");
		expect(group).toMatchObject({
			description: CONNECTOR_MESSAGES.groupDescription,
		});
		expect(
			(group as { options?: { name: string }[] } | undefined)?.options?.map(
				(option) => option.name,
			),
		).toEqual(["add", "list", "describe", "resync", "remove"]);
	});

	test("an added connector reaches the host through CONNECTORS, and removing it bumps the version", async () => {
		const host = await boot({});
		const connectors = host.context.services.get(CONNECTORS);
		// The host's preflight loaded the (empty) table once.
		const loaded = connectors.version;
		expect(loaded).toBe(1);

		const added = addNotion();
		await handle(host, added.interaction as never);
		expect(added.replies.text()).toContain(CONNECTOR_MESSAGES.addedTitle);
		expect(connectors.version).toBe(loaded + 1);
		expect(connectors.profileSources()).toEqual([
			{
				name: "notion",
				description: "Pages in the owner's Notion",
				serverName: "roundtable-conn-notion",
			},
		]);
		expect(connectors.servers()[0]?.tools).toEqual([
			"notion-search",
			"notion-get-page",
		]);
		expect(connectors.servers()[0]?.url).toStartWith(cf.url);
		expect([...cf.gateways.values()][0]?.authType).toBe("bearer");

		const removed = fakeInteraction({
			group: "connector",
			sub: "remove",
			strings: { name: "notion" },
		});
		await handle(host, removed.interaction as never);
		expect(removed.replies.text()).toContain(CONNECTOR_MESSAGES.removedTitle);
		expect(connectors.version).toBe(loaded + 2);
		expect(connectors.list()).toEqual([]);
		expect(cf.gateways.size).toBe(0);
		expect(cf.servers.size).toBe(0);
	});

	test("holds a connector's tool its hints mark destructive or not read-only, and runs the rest", async () => {
		const host = await boot({});
		cf.upstream["https://mcp.example.test/mcp"] = [
			{ name: "read", annotations: { readOnlyHint: true } },
			{ name: "wipe", annotations: { destructiveHint: true } },
			{
				name: "derive",
				annotations: { readOnlyHint: false, destructiveHint: false },
			},
			{ name: "plain", annotations: {} },
			"bare",
		];
		await handle(host, addNotion().interaction as never);
		const description = await host.hold("notion-wipe", {
			kind: "order",
			id: "7",
		});
		expect(String(description)).toContain("notion-wipe");
		expect(String(description)).toContain("kind order, id 7");
		expect(await host.hold("notion-derive", {})).toBeDefined();
		for (const name of ["read", "plain", "bare"])
			expect(await host.hold(`notion-${name}`, {})).toBeUndefined();
		expect(await host.hold("shell", {})).toBeUndefined();
		expect(
			await host.context.services
				.get(CONNECTORS)
				.resolve("roundtable-conn-notion"),
		).toMatchObject({ hints: { "notion-wipe": { destructiveHint: true } } });
	});

	test("forgets a removed connector's hints", async () => {
		const host = await boot({});
		cf.upstream["https://mcp.example.test/mcp"] = [
			{ name: "wipe", annotations: { destructiveHint: true } },
		];
		await handle(host, addNotion().interaction as never);
		expect(await host.hold("notion-wipe", {})).toBeDefined();
		await host.context.services.get(CONNECTORS).remove("notion");
		expect(await host.hold("notion-wipe", {})).toBeUndefined();
	});

	test("a connector added before a restart is read again at boot", async () => {
		const first = await boot({});
		await handle(first, addNotion().interaction as never);
		await first.stop();

		const second = await boot({}, true);
		expect(
			second.context.services.get(CONNECTORS).profileSources(),
		).toMatchObject([{ name: "notion", serverName: "roundtable-conn-notion" }]);
	});

	const MCP = "https://mcp.example.test/mcp";
	const resyncOf = (name?: string) =>
		fakeInteraction({
			group: "connector",
			sub: "resync",
			...(name ? { strings: { name } } : {}),
		});

	test("a connector whose upstream renamed a tool is attached to the new name at boot, and the hint rule holds it", async () => {
		const first = await boot({});
		await handle(first, addNotion().interaction as never);
		await first.stop();
		running = undefined;
		cf.upstream[MCP] = [
			"search",
			{ name: "wipe-all", annotations: { destructiveHint: true } },
		];

		const second = await boot({}, true);
		const connectors = second.context.services.get(CONNECTORS);
		expect(connectors.servers()[0]?.tools).toEqual([
			"notion-search",
			"notion-wipe-all",
		]);
		expect(connectors.servers()[0]?.hints).toEqual({
			"notion-wipe-all": { destructiveHint: true },
		});
		expect(await second.hold("notion-wipe-all", {})).toBeDefined();
		// The connector, its gateway and its virtual server are the ones added before.
		expect(cf.gateways.size).toBe(1);
		expect(cf.servers.size).toBe(1);
	});

	test("a boot whose refresh fails keeps the connector and its old server", async () => {
		const first = await boot({});
		await handle(first, addNotion().interaction as never);
		await first.stop();
		running = undefined;
		cf.upstream[MCP] = ["search", "find-page"];
		cf.refreshFails.set(MCP, "upstream is down");

		const second = await boot({}, true);
		const connectors = second.context.services.get(CONNECTORS);
		expect(connectors.list().map((c) => c.name)).toEqual(["notion"]);
		expect(connectors.servers()[0]?.tools).toEqual([
			"notion-search",
			"notion-get-page",
		]);
		expect(cf.servers.size).toBe(1);
	});

	test("/connector resync <name> shows what changed and asks ContextForge for five requests", async () => {
		const host = await boot({});
		await handle(host, addNotion().interaction as never);
		const connectors = host.context.services.get(CONNECTORS);
		const version = connectors.version;
		const [serverId] = [...cf.servers.keys()];
		const [gatewayId] = [...cf.gateways.keys()];
		cf.upstream[MCP] = ["search", "find-page"];
		cf.requests.length = 0;

		const resync = resyncOf("notion");
		await handle(host, resync.interaction as never);

		const text = resync.replies.text();
		expect(text).toContain(CONNECTOR_MESSAGES.resyncedTitle);
		expect(text).toContain("`notion-find-page`");
		expect(text).toContain(
			CONNECTOR_MESSAGES.resyncChanges(
				"`notion-find-page`",
				"`notion-get-page`",
			),
		);
		// The old and new names were listed while the tools changed, then the new ones alone.
		expect(connectors.version).toBe(version + 2);
		expect(cf.requests).toEqual([
			`POST /gateways/${gatewayId}/tools/refresh`,
			"GET /tools",
			`PUT /servers/${serverId}`,
			"GET /servers",
			`GET /servers/${serverId}/tools`,
		]);
	});

	test("/connector resync with no name resyncs every connector and reports one that fails", async () => {
		const host = await boot({});
		await handle(host, addNotion().interaction as never);
		cf.upstream["https://mcp.other.test/mcp"] = ["list"];
		await host.context.services.get(CONNECTORS).add({
			name: "other",
			url: "https://mcp.other.test/mcp",
			description: "Other",
		});
		cf.upstream[MCP] = ["search", "find-page"];
		cf.refreshFails.set("https://mcp.other.test/mcp", "gone");

		const resync = resyncOf();
		await handle(host, resync.interaction as never);

		const text = resync.replies.text();
		expect(text).toContain(CONNECTOR_MESSAGES.resyncedAllTitle);
		expect(text).toContain("`notion-find-page`");
		expect(text).toContain(
			CONNECTOR_MESSAGES.resyncFailed(
				"other",
				"ContextForge could not read the server's tools again: gone",
			),
		);
		expect(
			host.context.services
				.get(CONNECTORS)
				.list()
				.map((c) => c.name),
		).toEqual(["notion", "other"]);
	});

	test("/connector resync of an unknown or unreadable connector is a panel, not a crash", async () => {
		const host = await boot({});
		await handle(host, addNotion().interaction as never);
		const unknown = resyncOf("nope");
		await handle(host, unknown.interaction as never);
		expect(unknown.replies.text()).toContain(
			CONNECTOR_MESSAGES.unknownConnector("nope"),
		);
		cf.refreshFails.set(MCP, "upstream is down");
		const down = resyncOf("notion");
		await handle(host, down.interaction as never);
		expect(down.replies.text()).toContain("upstream is down");
		expect(host.context.services.get(CONNECTORS).servers()[0]?.tools).toEqual([
			"notion-search",
			"notion-get-page",
		]);
	});

	test("a refusal reaches the owner as a panel and changes nothing", async () => {
		const host = await boot({});
		const { interaction, replies } = fakeInteraction({
			group: "connector",
			sub: "add",
			modal: CONNECTOR_MODAL_ID,
			fields: { name: "Bad Name", url: "https://x.test", description: "x" },
		});
		await handle(host, interaction as never);
		expect(replies.text()).toContain(CONNECTOR_MESSAGES.nameRule);
		expect(cf.gateways.size).toBe(0);
	});

	test("a non-owner's form is ignored", async () => {
		const host = await boot({});
		const { interaction, replies } = fakeInteraction({
			user: "someone-else",
			group: "connector",
			sub: "add",
			modal: CONNECTOR_MODAL_ID,
		});
		await handle(host, interaction as never);
		expect(replies.edits).toEqual([]);
		expect(cf.gateways.size).toBe(0);
	});

	test("the host's wording and server prefix replace the defaults", async () => {
		const host = await boot({
			serverPrefix: "acme-",
			messages: { addedTitle: "Added!" },
		});
		const added = addNotion();
		await handle(host, added.interaction as never);
		expect(added.replies.text()).toContain("Added!");
		expect(
			host.context.services.get(CONNECTORS).profileSources()[0]?.serverName,
		).toBe("acme-notion");
	});

	test("the virtual server's description and the list's label separator take the host's wording", async () => {
		const host = await boot({
			messages: {
				serverDescription: (name, description) =>
					`Mine ${name} / ${description}`,
				labelSeparator: " ~ ",
			},
		});
		await handle(host, addNotion().interaction as never);
		expect([...cf.servers.values()][0]?.description).toBe(
			"Mine notion / Pages in the owner's Notion",
		);
		const list = fakeInteraction({ group: "connector", sub: "list" });
		await handle(host, list.interaction as never);
		expect(list.replies.text()).toContain(
			"**notion** ~ https://mcp.example.test/…",
		);
	});

	test("the stored connectors are loaded before any service starts, so no command or turn sees an empty list", async () => {
		const first = await boot({});
		await handle(first, addNotion().interaction as never);
		await running?.stop();
		running = undefined;
		const seen: { count: number; version: number }[] = [];
		const plugin = mcpConnectors({ contextForge: contextForge(`${cf.url}/`) });
		// Registered first, so its service starts before any service of the connectors plugin.
		const probe = definePlugin({
			name: "connector-probe",
			setup: ({ services }) => {
				const connectors = services.lazy(CONNECTORS);
				return {
					services: [
						{
							name: "connector-probe",
							start: () => {
								seen.push({
									count: connectors().list().length,
									version: connectors().version,
								});
							},
						},
					],
				};
			},
		});
		running = await testHost({ plugins: [probe, plugin] });
		expect(seen).toEqual([{ count: 1, version: 1 }]);
	});

	/** Adds a connector for an upstream that offers `tools`, through the Discord form. */
	async function addConnector(host: TestHost, name: string, tools: string[]) {
		const url = `https://mcp.${name}.test/mcp`;
		cf.upstream[url] = tools;
		const added = fakeInteraction({
			group: "connector",
			sub: "add",
			modal: CONNECTOR_MODAL_ID,
			fields: {
				name,
				url,
				description: `the ${name} tools`,
				header: "",
				token: "",
			},
		});
		await handle(host, added.interaction as never);
	}

	/** Restarts the host over the same connectors, as a deploy does. */
	async function restart(
		options: Partial<Parameters<typeof mcpConnectors>[0]>,
	) {
		await running?.stop();
		running = undefined;
		return boot(options, true);
	}

	test("a boot resync spaces its admin requests by the interval", async () => {
		const first = await boot({});
		await addConnector(first, "alpha", ["one"]);
		await addConnector(first, "beta", ["one"]);
		for (const name of ["alpha", "beta"])
			cf.upstream[`https://mcp.${name}.test/mcp`] = ["one", "two"];
		cf.requests.length = 0;
		cf.requestTimes.length = 0;
		const interval = 100;
		await restart({ resyncIntervalMs: interval });
		// Load reads each server first (2 requests); a resync of a connector then makes five.
		const requests = cf.requests.slice(4);
		const at = cf.requestTimes.slice(4);
		expect(requests.map((r) => r.split(" ")[0])).toEqual([
			...["POST", "GET", "PUT", "GET", "GET"],
			...["POST", "GET", "PUT", "GET", "GET"],
		]);
		// Refresh, tools and update take a slot each, and the two reads of a server take two.
		const gap = (from: number, to: number) => (at[to] ?? 0) - (at[from] ?? 0);
		const slot = interval * 0.9;
		for (const [from, to] of [
			[0, 1],
			[1, 2],
			[2, 3],
			[5, 6],
			[6, 7],
			[7, 8],
		] as const)
			expect(gap(from, to)).toBeGreaterThanOrEqual(slot);
		expect(gap(3, 5)).toBeGreaterThanOrEqual(2 * slot);
		const servers = running?.context.services.get(CONNECTORS).servers();
		expect(servers?.map((s) => s.tools)).toEqual([
			["alpha-one", "alpha-two"],
			["beta-one", "beta-two"],
		]);
	});

	test("the default pace stays under 60 requests a minute", () => {
		expect(60_000 / DEFAULT_RESYNC_INTERVAL_MS).toBeLessThanOrEqual(60);
	});

	test("a 429 at boot stops the resync, keeps the old servers, and is not asked again", async () => {
		const first = await boot({});
		for (const name of ["alpha", "beta", "gamma"])
			await addConnector(first, name, ["one"]);
		for (const name of ["alpha", "beta", "gamma"])
			cf.upstream[`https://mcp.${name}.test/mcp`] = ["two"];
		const base = cf.requests.length;
		// Boot reads each of the three servers (2 requests each), resyncs alpha (5), and gets beta's refresh through.
		cf.rateLimitAfter = base + 6 + 5 + 1;
		const host = await restart({});
		const connectors = host.context.services.get(CONNECTORS);
		expect(connectors.servers().map((s) => s.tools)).toEqual([
			["alpha-two"],
			["beta-one"],
			["gamma-one"],
		]);
		// beta's tools request was the one refused; nothing was asked after it.
		expect(cf.requests.length).toBe(base + 6 + 5 + 1 + 1);
		expect(cf.requests.at(-1)).toBe("GET /tools");
		// The refusal is remembered: asking again sends nothing and reports all three as not resynced.
		const before = cf.requests.length;
		const outcomes = await connectors.resyncAll();
		expect(cf.requests.length).toBe(before);
		expect(outcomes).toMatchObject([
			{ name: "alpha", error: CONNECTOR_MESSAGES.resyncNotAttempted },
			{ name: "beta", error: CONNECTOR_MESSAGES.resyncNotAttempted },
			{ name: "gamma", error: CONNECTOR_MESSAGES.resyncNotAttempted },
		]);
		await expect(connectors.resync("alpha")).rejects.toThrow(
			CONNECTOR_MESSAGES.resyncNotAttempted,
		);
		expect(cf.requests.length).toBe(before);
	});
});
