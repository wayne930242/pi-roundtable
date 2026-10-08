import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SQL } from "bun";
import { type ChannelKey, CONVERSATIONS, IDENTITY } from "pi-roundtable";
import {
	describeDb,
	type TestHost,
	testDatabaseUrl,
	testHost,
} from "pi-roundtable/testing";
import {
	type RecordingRuntime,
	recordingRuntime,
} from "../testing/recording-runtime.ts";
import { DEFAULT_PERSONA, MEMBER_PERSONA } from "./default-conversation.ts";
import { remoteMcp } from "./remote-mcp-plugin.ts";

const TOKEN = "dispatch-token-for-principal-tests";
const PUBLIC_URL = "https://bot.example.test";
/** The test host's owner, Ada, as `testHost` writes her in `access`. */
const ADA = "100000000000000001";
/** A member with a lasting role, as `roundtable principal grant` leaves one. */
const KAI = "966666600000000041";

const jsonOf = (result: unknown) =>
	JSON.parse(
		(result as { content: { text: string }[] }).content[0]?.text ?? "{}",
	);

// The plugin on a real host, its token linked by the identity plugin over PostgreSQL. Runs only
// when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("remote MCP bound to a principal on a host", () => {
	let sql: SQL;
	/** The hosts still running, stopped after the tests. */
	const hosts = new Set<TestHost>();

	beforeAll(async () => {
		sql = new SQL(testDatabaseUrl);
	});

	afterAll(async () => {
		await Promise.all([...hosts].map((host) => host.stop()));
		await sql.close();
	});

	/** A host with the plugin bound as given, its turns on a recording runtime. */
	async function boot(principal?: string) {
		const dataDir = mkdtempSync(join(tmpdir(), "roundtable-mcp-principal-"));
		const socketPath = join(dataDir, "public.sock");
		const runtime = recordingRuntime();
		const host = await testHost({
			config: { dataDir, http: { publicUrl: PUBLIC_URL, socketPath } },
			runtime,
			plugins: [
				remoteMcp({
					dispatchToken: TOKEN,
					publicUrl: PUBLIC_URL,
					...(principal ? { principal } : {}),
				}),
			],
		});
		hosts.add(host);
		const stop = async () => {
			hosts.delete(host);
			await host.stop();
		};
		return { host, runtime, socketPath, stop };
	}

	/** Dispatches one message and waits for its run; the error code when the dispatch is refused. */
	async function relay(
		socketPath: string,
		message: string,
		sessionId?: string,
	): Promise<{
		status?: string;
		sessionId?: string;
		error?: string;
	}> {
		const client = new Client({ name: "test", version: "1.0.0" });
		await client.connect(
			new StreamableHTTPClientTransport(
				new URL("http://localhost/mcp/personal"),
				{
					requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
					fetch: (input, init) =>
						fetch(input, { ...init, unix: socketPath } as RequestInit),
				},
			),
		);
		try {
			const started = jsonOf(
				await client.callTool({
					name: "agent_dispatch",
					arguments: { message, ...(sessionId ? { sessionId } : {}) },
				}),
			);
			if (started.error) return { error: started.error };
			for (let tries = 0; tries < 100; tries++) {
				const state = jsonOf(
					await client.callTool({
						name: "agent_result",
						arguments: { runId: started.runId },
					}),
				);
				if (state.status !== "working")
					return { ...state, sessionId: started.sessionId };
				await Bun.sleep(20);
			}
			throw new Error("the run did not finish");
		} finally {
			await client.close();
		}
	}

	const lastTurn = (runtime: RecordingRuntime) => runtime.turns.at(-1);

	test("without a principal the token is the primary owner's: an owner-tier turn as 0.8's, private to the owner", async () => {
		const { host, runtime, socketPath, stop } = await boot();
		const identity = host.context.services.get(IDENTITY);
		expect(await identity.principalOf("token:remote-mcp")).toBe(ADA);
		expect(host.context.sessions().persona("remote")).toBe(DEFAULT_PERSONA);
		const result = await relay(socketPath, "ping");
		expect(result.status).toBe("completed");
		expect(lastTurn(runtime)).toMatchObject({
			channel: `mcp:${result.sessionId}`,
			kind: "remote",
			speaker: { id: ADA, name: "Ada", tier: "owner", principalId: ADA },
		});
		expect(
			await host.context.services
				.get(CONVERSATIONS)
				.get(`mcp:${result.sessionId}`),
		).toMatchObject({ visibility: "private", principalId: ADA });
		await stop();
	});

	test("bound to a member, the turns are theirs at the member tier, and the owner's sessions are not", async () => {
		await sql`DELETE FROM principal_identities WHERE principal_id = ${KAI}`;
		await sql`DELETE FROM principals WHERE id = ${KAI}`;
		await sql`INSERT INTO principals (id, display_name) VALUES (${KAI}, 'Kai')`;
		await sql`INSERT INTO principal_roles (principal_id, role, source) VALUES (${KAI}, 'member', 'cli')`;

		const owner = await boot();
		const opened = await relay(owner.socketPath, "hi");
		expect(opened.status).toBe("completed");
		await owner.stop();

		const member = await boot(KAI);
		expect(
			await member.host.context.services
				.get(IDENTITY)
				.principalOf("token:remote-mcp"),
		).toBe(KAI);
		expect(member.host.context.sessions().persona("remote")).toBe(
			MEMBER_PERSONA,
		);
		expect(await relay(member.socketPath, "mine?", opened.sessionId)).toEqual({
			error: "SESSION_NOT_FOUND",
		});
		const own = await relay(member.socketPath, "hello");
		expect(own.status).toBe("completed");
		expect(lastTurn(member.runtime)?.speaker).toEqual({
			id: KAI,
			name: "Kai",
			tier: "member",
			principalId: KAI,
		});
		expect(
			await member.host.context.services
				.get(CONVERSATIONS)
				.get(`mcp:${own.sessionId}`),
		).toMatchObject({ visibility: "private", principalId: KAI });
		await member.stop();

		// Bound back to the owner at the next start: the token moves, and Kai's session is not the owner's.
		const back = await boot();
		expect(await relay(back.socketPath, "Kai's?", own.sessionId)).toEqual({
			error: "SESSION_NOT_FOUND",
		});
		expect(
			(await relay(back.socketPath, "mine", opened.sessionId)).status,
		).toBe("completed");
		await back.stop();
	});

	test("a session 0.8 opened is handed to the primary owner at the start, its conversation adopted as theirs, and no one else's turn reaches it", async () => {
		// As 0.8 left it: the session of no principal, its conversation shared and no one's.
		const id = crypto.randomUUID();
		await sql`INSERT INTO remote_agent_sessions (id) VALUES (${id})`;
		await sql`
			INSERT INTO conversations (key, surface, kind, visibility)
			VALUES (${`mcp:${id}`}, 'mcp', 'remote', 'shared')`;
		// A shared conversation of no principal that is no 0.8 session stays as it is.
		const room: ChannelKey = `fake:room-${id}`;
		await sql`
			INSERT INTO conversations (key, surface, kind, visibility)
			VALUES (${room}, 'fake', 'study', 'shared')`;
		await sql`DELETE FROM principal_identities WHERE principal_id = ${KAI}`;
		await sql`DELETE FROM principals WHERE id = ${KAI}`;
		await sql`INSERT INTO principals (id, display_name) VALUES (${KAI}, 'Kai')`;
		await sql`INSERT INTO principal_roles (principal_id, role, source) VALUES (${KAI}, 'member', 'cli')`;

		const member = await boot(KAI);
		const registry = member.host.context.services.get(CONVERSATIONS);
		expect(await registry.get(`mcp:${id}`)).toMatchObject({
			visibility: "private",
			principalId: ADA,
		});
		expect(await registry.get(room)).toMatchObject({
			visibility: "shared",
		});
		expect((await registry.get(room))?.principalId).toBeUndefined();
		expect(await relay(member.socketPath, "mine?", id)).toEqual({
			error: "SESSION_NOT_FOUND",
		});
		await member.stop();

		const owner = await boot();
		expect((await relay(owner.socketPath, "still there?", id)).status).toBe(
			"completed",
		);
		expect(
			await owner.host.context.services.get(CONVERSATIONS).get(`mcp:${id}`),
		).toMatchObject({ visibility: "private", principalId: ADA });
		await owner.stop();
	});

	test("bound to a principal that does not exist, the start stops and says so", async () => {
		expect(boot("966666600000000049")).rejects.toThrow(
			"plugin remote-mcp: token:remote-mcp is bound to principal 966666600000000049, and there is no principal 966666600000000049. roundtable principal list shows the principals, and roundtable principal create makes one.",
		);
	});
});
