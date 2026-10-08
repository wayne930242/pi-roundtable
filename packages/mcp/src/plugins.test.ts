import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SQL } from "bun";
import { migrateDatabase } from "pi-roundtable";
import {
	describeDb,
	type TestHost,
	testDatabaseUrl,
	testHost,
} from "pi-roundtable/testing";
import { CONNECTORS, mcpConnectors, REMOTE_MCP, remoteMcp } from "./index.ts";
import {
	type RecordingRuntime,
	recordingRuntime,
} from "./testing/recording-runtime.ts";

const DISPATCH_TOKEN = "dispatch-token-for-tests";
const PUBLIC_URL = "https://bot.example.test";

const jsonOf = (result: unknown) =>
	JSON.parse(
		(result as { content: { text: string }[] }).content[0]?.text ?? "{}",
	);

// Both plugins on a real host: its migrations, its HTTP listener, its router, and the core's
// turns over a recording runtime. Runs only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("both plugins on a host", () => {
	let host: TestHost;
	let socketPath: string;
	let runtime: RecordingRuntime;

	beforeAll(async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "roundtable-mcp-test-"));
		socketPath = join(dataDir, "public.sock");
		runtime = recordingRuntime();
		const connectors = mcpConnectors({
			contextForge: {
				url: "http://localhost:4444/",
				jwtSecret: "secret",
				user: "admin@example.com",
			},
		});
		const remote = remoteMcp({
			dispatchToken: DISPATCH_TOKEN,
			publicUrl: PUBLIC_URL,
		});
		// Another test file may have left connectors and grants in the tables.
		await migrateDatabase(testDatabaseUrl, [connectors, remote]);
		const sql = new SQL(testDatabaseUrl);
		await sql`DELETE FROM owner_connectors`;
		await sql`DELETE FROM discord_mcp_bundles`;
		await sql.close();
		host = await testHost({
			config: { dataDir, http: { publicUrl: PUBLIC_URL, socketPath } },
			runtime,
			plugins: [connectors, remote],
		});
	});

	afterAll(async () => {
		await host.stop();
	});

	/** An MCP client whose HTTP goes through the host's listener socket. */
	async function connect(path: string, headers: Record<string, string> = {}) {
		const client = new Client({ name: "test", version: "1.0.0" });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`http://localhost${path}`), {
				requestInit: { headers },
				fetch: (input, init) =>
					fetch(input, { ...init, unix: socketPath } as RequestInit),
			}),
		);
		return client;
	}

	test("adds the connector and grant commands under the root command", () => {
		const root = host.commands
			.composed()
			.commands.find((command) => command.name === "roundtable");
		const groups = (root?.options ?? []).map((option) => option.name);
		expect(groups).toContain("connector");
		expect(groups).toContain("mcp");
	});

	test("provides the connector registry to other plugins", () => {
		const connectors = host.context.services.get(CONNECTORS);
		expect(connectors.version).toBe(0);
		expect(connectors.list()).toEqual([]);
		expect(connectors.servers()).toEqual([]);
		expect(connectors.profileSources()).toEqual([]);
		expect(connectors.token.split(".")).toHaveLength(3);
		expect(connectors.resolve).toBeFunction();
		expect(connectors.admin.gateways).toBeFunction();
		expect(connectors.admin.servers).toBeFunction();
	});

	test("provides the grants to other plugins, empty before any is made", async () => {
		const { grants, describeGrant } = host.context.services.get(REMOTE_MCP);
		expect(await grants.bundles()).toEqual([]);
		expect(await grants.grants()).toEqual([]);
		expect(describeGrant).toBeFunction();
	});

	/** Polls a run until the host's turn has finished. */
	async function finished(client: Client, runId: string) {
		for (let tries = 0; tries < 100; tries++) {
			const state = jsonOf(
				await client.callTool({ name: "agent_result", arguments: { runId } }),
			);
			if (state.status !== "working") return state;
			await Bun.sleep(20);
		}
		throw new Error("the run did not finish");
	}

	test("a relayed turn runs on the core as an owner-tier remote turn, and its answer is polled", async () => {
		const client = await connect("/mcp/personal", {
			Authorization: `Bearer ${DISPATCH_TOKEN}`,
		});
		const started = jsonOf(
			await client.callTool({
				name: "agent_dispatch",
				arguments: { message: "ping" },
			}),
		);
		expect(await finished(client, started.runId)).toEqual({
			status: "completed",
			text: "pong",
		});
		const turn = runtime.turns.at(-1);
		// The primary owner's principal, which the dispatch token stands for by default.
		expect(turn).toMatchObject({
			channel: `mcp:${started.sessionId}`,
			kind: "remote",
			speaker: {
				id: "100000000000000001",
				name: "Ada",
				tier: "owner",
				principalId: "100000000000000001",
			},
		});
		expect(turn?.text).toContain("\nping");
		expect(turn?.text).toContain("the owner");
		await client.close();
	});

	test("the claim starts a remote conversation over and deletes it with its session", async () => {
		const client = await connect("/mcp/personal", {
			Authorization: `Bearer ${DISPATCH_TOKEN}`,
		});
		const { runId, sessionId } = jsonOf(
			await client.callTool({
				name: "agent_dispatch",
				arguments: { message: "hello" },
			}),
		);
		await finished(client, runId);
		const channel = `mcp:${sessionId}` as const;
		expect(await host.conversations.startFresh(channel)).toBe("remote");
		expect(runtime.fresh).toContain(channel);
		expect(host.conversations.stop(channel)).toBe(true);
		expect(runtime.stopped).toContain(channel);
		// The queue releases the channel a tick after its task resolves.
		await Bun.sleep(0);
		expect(await host.conversations.deleteConversation(channel)).toBe(
			"deleted",
		);
		expect(runtime.deleted).toContain(channel);
		const again = jsonOf(
			await client.callTool({
				name: "agent_dispatch",
				arguments: { message: "again", sessionId },
			}),
		);
		expect(again.error).toBe("SESSION_NOT_FOUND");
		await client.close();
	});

	test("the remote persona is registered for the default conversations", () => {
		expect(host.context.sessions().persona("remote")).toContain("owner");
	});
});
