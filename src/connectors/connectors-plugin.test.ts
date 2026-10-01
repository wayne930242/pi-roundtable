import { afterAll, afterEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { migrateDatabase } from "pi-roundtable";
import {
	describeDb,
	type TestHost,
	testDatabaseUrl,
	testHost,
} from "pi-roundtable/testing";
import { fakeContextForge } from "../testing/fake-contextforge.ts";
import { fakeInteraction } from "../testing/fake-interaction.ts";
import { CONNECTOR_MODAL_ID } from "./connector-commands.ts";
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
			...options,
		});
		await migrateDatabase(testDatabaseUrl, [plugin]);
		const sql = new SQL(testDatabaseUrl);
		if (!keepConnectors) await sql`DELETE FROM owner_connectors`;
		await sql.close();
		if (!keepConnectors) cf.reset();
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

	test("adds /<root> connector with its four subcommands", async () => {
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
		).toEqual(["add", "list", "describe", "remove"]);
	});

	test("an added connector reaches the host through CONNECTORS, and removing it bumps the version", async () => {
		const host = await boot({});
		const connectors = host.context.services.get(CONNECTORS);
		expect(connectors.version).toBe(0);

		const added = addNotion();
		await handle(host, added.interaction as never);
		expect(added.replies.text()).toContain(CONNECTOR_MESSAGES.addedTitle);
		expect(connectors.version).toBe(1);
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
		expect(connectors.version).toBe(2);
		expect(connectors.list()).toEqual([]);
		expect(cf.gateways.size).toBe(0);
		expect(cf.servers.size).toBe(0);
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
});
