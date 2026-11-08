import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SQL } from "bun";
import {
	type HttpRoute,
	migrateDatabase,
	type RoundtablePlugin,
} from "pi-roundtable";
import { DISCORD } from "pi-roundtable/discord";
import {
	describeDb,
	type TestHost,
	testDatabaseUrl,
	testHost,
} from "pi-roundtable/testing";
import { CONNECTORS, mcpConnectors, REMOTE_MCP, remoteMcp } from "./index.ts";
import { fakeContextForge } from "./testing/fake-contextforge.ts";
import { recordingRuntime } from "./testing/recording-runtime.ts";

const TOKEN = "dispatch-token-for-tests";
const PUBLIC_URL = "https://bot.example.test";

const jsonOf = (result: unknown) =>
	JSON.parse(
		(result as { content: { text: string }[] }).content[0]?.text ?? "{}",
	);

/** The plugin as it is, keeping the HTTP routes its setup contributes. */
function keepingRoutes(plugin: RoundtablePlugin, routes: HttpRoute[]) {
	return {
		...plugin,
		setup: async (context: Parameters<RoundtablePlugin["setup"]>[0]) => {
			const contribution = await plugin.setup(context);
			routes.push(...(contribution.http ?? []));
			return contribution;
		},
	} satisfies RoundtablePlugin;
}

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("both plugins on a host without Discord", () => {
	const cf = fakeContextForge();
	const dir = mkdtempSync(join(tmpdir(), "roundtable-mcp-no-discord-"));
	let running: TestHost | undefined;

	afterEach(async () => {
		await running?.stop();
		running = undefined;
	});

	afterAll(() => {
		cf.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	test("the connectors load and remote MCP answers at /mcp/personal, with no channel tools", async () => {
		const connectors = mcpConnectors({
			contextForge: {
				url: cf.url,
				jwtSecret: "secret",
				user: "admin@example.com",
			},
		});
		const routes: HttpRoute[] = [];
		const remote = keepingRoutes(
			remoteMcp({ dispatchToken: TOKEN, publicUrl: PUBLIC_URL }),
			routes,
		);
		await migrateDatabase(testDatabaseUrl, [connectors, remote]);
		const sql = new SQL(testDatabaseUrl);
		await sql`DELETE FROM owner_connectors`;
		await sql.close();
		cf.reset();
		const runtime = recordingRuntime();
		running = await testHost({
			discord: false,
			// The listener the endpoints need; no Discord and no agent guild.
			config: {
				http: { publicUrl: PUBLIC_URL, socketPath: join(dir, "public.sock") },
			},
			runtime,
			plugins: [connectors, remote],
		});
		const { services } = running.context;
		expect(services.find(DISCORD)).toBeUndefined();
		expect(running.commands.added).toEqual([]);
		expect(services.get(CONNECTORS).list()).toEqual([]);
		expect(await services.get(REMOTE_MCP).grants.bundles()).toEqual([]);
		expect(routes.map((route) => route.name)).toEqual(["mcp-personal"]);

		const client = new Client({ name: "test", version: "1.0.0" });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`${PUBLIC_URL}/mcp/personal`), {
				requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
				fetch: async (input, init) =>
					// biome-ignore lint/style/noNonNullAssertion: the one route is checked above.
					routes[0]!.handle(new Request(String(input), init as RequestInit)),
			}),
		);
		const tools = (await client.listTools()).tools.map((tool) => tool.name);
		expect(tools).toEqual(["agent_dispatch", "agent_result"]);
		const started = jsonOf(
			await client.callTool({
				name: "agent_dispatch",
				arguments: { message: "hi" },
			}),
		);
		let state = { status: "working", text: "" };
		for (let tries = 0; tries < 100 && state.status === "working"; tries++) {
			await Bun.sleep(10);
			state = jsonOf(
				await client.callTool({
					name: "agent_result",
					arguments: { runId: started.runId },
				}),
			);
		}
		await client.close();
		expect(state).toMatchObject({ status: "completed", text: "pong" });
		expect(runtime.turns.at(-1)?.channel).toStartWith("mcp:");
	});
});
