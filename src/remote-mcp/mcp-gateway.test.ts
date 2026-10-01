import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SQL } from "bun";
import type { ChannelExecutor } from "pi-roundtable/discord";
import {
	describeDb,
	openTestStore,
	silentLogger,
	type TestStore,
	testDatabaseUrl,
} from "pi-roundtable/testing";
import { ChannelGrantStore, newChannelEndpoint } from "./channel-grants.ts";
import { McpGateway } from "./mcp-gateway.ts";
import { RemoteAgent } from "./remote-agent.ts";

const DISPATCH_TOKEN = "dispatch-token-for-tests";
const BASE = "https://bot.example.test";

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("PostgreSQL", () => {
	let grants: TestStore<ChannelGrantStore>;
	let gateway: McpGateway;
	const executed: string[] = [];

	const executor: ChannelExecutor = {
		inspect: async () => ({ guildId: "900" }),
		names: async () => ({
			guildName: "Example Server",
			channelName: "lobby-2",
		}),
		execute: async (tool) => {
			executed.push(tool);
			return { messages: [] };
		},
	};

	beforeAll(async () => {
		const sql = new SQL(testDatabaseUrl);
		await sql`DROP TABLE IF EXISTS discord_channel_grants`;
		await sql`DROP TABLE IF EXISTS discord_mcp_bundles`;
		await sql.close();
		grants = await openTestStore(ChannelGrantStore);
		let next = 0;
		gateway = new McpGateway({
			dispatchToken: DISPATCH_TOKEN,
			agent: new RemoteAgent({
				sessions: {
					create: async () => `00000000-0000-4000-8000-00000000000${next++}`,
					touch: async () => true,
				},
				answer: async (_channel, text) => ({
					ok: true,
					text: `Received: ${text.split("\n").at(-1)}`,
				}),
				logger: silentLogger(),
			}),
			grants,
			executor: () => executor,
			logger: silentLogger(),
		});
	});

	afterAll(async () => {
		await grants.close();
	});

	/** An MCP client whose HTTP goes straight into the gateway. */
	async function connect(
		endpoint: string,
		headers: Record<string, string> = {},
	) {
		const client = new Client({ name: "test", version: "1.0.0" });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(endpoint), {
				requestInit: { headers },
				fetch: async (input, init) =>
					gateway.handle(new Request(String(input), init as RequestInit)),
			}),
		);
		return client;
	}

	const parse = (result: unknown) =>
		JSON.parse(
			(result as { content: { text: string }[] }).content[0]?.text ?? "{}",
		);

	describe("McpGateway /mcp/personal", () => {
		test("dispatches a turn and returns its result", async () => {
			const client = await connect(`${BASE}/mcp/personal`, {
				Authorization: `Bearer ${DISPATCH_TOKEN}`,
			});
			const names = (await client.listTools()).tools.map((t) => t.name);
			expect(names).toEqual(["agent_dispatch", "agent_result"]);
			const started = parse(
				await client.callTool({
					name: "agent_dispatch",
					arguments: { message: "Hello" },
				}),
			);
			await Bun.sleep(0);
			const done = parse(
				await client.callTool({
					name: "agent_result",
					arguments: { runId: started.runId },
				}),
			);
			expect(done).toEqual({ status: "completed", text: "Received: Hello" });
			await client.close();
		});

		test("refuses a missing or wrong token, other paths, and browsers", async () => {
			const post = (path: string, headers: Record<string, string> = {}) =>
				gateway.handle(
					new Request(`${BASE}${path}`, {
						method: "POST",
						headers,
						body: "{}",
					}),
				);
			expect((await post("/mcp/personal")).status).toBe(401);
			expect(
				(await post("/mcp/personal", { Authorization: "Bearer nope" })).status,
			).toBe(401);
			expect((await post("/admin")).status).toBe(404);
			expect(
				(
					await post("/mcp/personal", {
						Authorization: `Bearer ${DISPATCH_TOKEN}`,
						Origin: "https://evil.example",
					})
				).status,
			).toBe(403);
		});
	});

	describe("McpGateway /mcp/discord", () => {
		test("exposes only the bundle's granted operations, and a rotated URL stops working", async () => {
			const endpoint = newChannelEndpoint(BASE);
			const { bundle } = await grants.ensureBundle("sos", endpoint.tokenHash, [
				"read",
			]);
			await grants.save({
				bundleId: bundle.id,
				channelId: "111",
				guildId: "900",
				operations: ["read"],
				displayName: "Lobby",
				description: "Small talk",
				guildName: "Example Server",
				channelName: "lobby-2",
				authorizedBy: "100000000000000001",
				authorizedAt: new Date(),
			});
			const client = await connect(endpoint.url);
			const names = (await client.listTools()).tools.map((t) => t.name);
			expect(names).toContain("discord_get_messages");
			expect(names).not.toContain("discord_send_message");
			const listed = parse(
				await client.callTool({
					name: "discord_list_authorized_channels",
					arguments: {},
				}),
			);
			expect(listed.channels[0]).toMatchObject({
				channelId: "111",
				name: "Lobby",
				accessible: true,
			});
			await client.callTool({
				name: "discord_get_messages",
				arguments: { channelId: "111" },
			});
			expect(executed).toEqual(["discord_get_messages"]);
			const refused = await client.callTool({
				name: "discord_get_messages",
				arguments: { channelId: "222" },
			});
			expect(parse(refused).error).toBe("CHANNEL_NOT_AUTHORIZED");
			await client.close();

			await grants.rotateToken(bundle.id, newChannelEndpoint(BASE).tokenHash);
			const stale = await gateway.handle(
				new Request(endpoint.url, { method: "POST", body: "{}" }),
			);
			expect(stale.status).toBe(401);
		});
	});
});
