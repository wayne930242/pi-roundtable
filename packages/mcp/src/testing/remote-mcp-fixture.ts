import { afterAll, beforeAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SQL } from "bun";
import {
	AGENTS,
	CONVERSATIONS,
	type ConversationRegistration,
	IDENTITY,
	IdentityError,
	migrateDatabase,
	type Speaker,
	type Tier,
} from "pi-roundtable";
import {
	fakeDiscord,
	servicePair,
	type TestPluginResult,
	testDatabaseUrl,
	testPlugin,
} from "pi-roundtable/testing";
import { remoteMcp } from "../remote-mcp/remote-mcp-plugin.ts";
import {
	type RecordingRuntime,
	recordingRuntime,
} from "./recording-runtime.ts";

export const TOKEN = "dispatch-token-for-tests";

export const PUBLIC_URL = "https://bot.example.test";

export const base = { dispatchToken: TOKEN, publicUrl: PUBLIC_URL };

/** The 0.8 texts a single-owner host's remote turns are told, word for word. */
export const PERSONA_0_8 =
	"You are the owner's personal assistant. The owner is writing to you through an outside agent over MCP, not on Discord, and each message begins with a note saying so. Answer the owner directly.";

export const RELAY_NOTE_0_8 =
	"(The owner wrote this in a personal agent that relays it over MCP, not on Discord. Answer the owner directly, just as you would on Discord; the agent passes your reply back.)";

/** Whom the dispatch token stands for, as `IDENTITY` reads it once the identity plugin linked it. */
export interface Bound {
	principal: string;
	name: string;
	tier: Tier;
	/** Throws from `speakerFor`, as for a principal disabled since. */
	refused?: boolean;
	/** The token linked to no one, as a replacement `IDENTITY` may leave it. */
	unlinked?: boolean;
}

export const OWNER_BOUND: Bound = {
	principal: "owner",
	name: "Owner",
	tier: "owner",
};

export const KAI_BOUND: Bound = {
	principal: "p_kai",
	name: "Kai",
	tier: "member",
};

/** `IDENTITY` with the token `identity` linked as `bound` says, the primary owner `owner`. */
export function boundIdentity(bound: Bound, identity = "token:remote-mcp") {
	return servicePair(IDENTITY, {
		principalOf: async (written) =>
			written === identity && !bound.unlinked ? bound.principal : undefined,
		tierOf: async (id) =>
			id === bound.principal && bound.tier === "owner" ? "owner" : undefined,
		speakerFor: async (id): Promise<Speaker> => {
			if (bound.refused) throw new IdentityError(`principal ${id} is disabled`);
			return { id, name: bound.name, tier: bound.tier, principalId: id };
		},
		owners: async () => [
			{ id: "owner", displayName: "Owner", disabled: false },
		],
	});
}

export const jsonOf = (result: unknown) =>
	JSON.parse(
		(result as { content: { text: string }[] }).content[0]?.text ?? "{}",
	);

export let sql: SQL;

export const harnesses: TestPluginResult[] = [];

/**
 * The plugin over a migrated database, with the agent server's runtime, a Discord stand-in,
 * `IDENTITY` with the token bound as given, and a registry that records each conversation.
 */
export async function boot(
	options: Parameters<typeof remoteMcp>[0],
	runtime: RecordingRuntime = recordingRuntime(),
	approves = false,
	bound: Bound = OWNER_BOUND,
) {
	const plugin = remoteMcp(options);
	await migrateDatabase(testDatabaseUrl, [plugin]);
	const discord = fakeDiscord();
	const registered: ConversationRegistration[] = [];
	const harness = await testPlugin(plugin, {
		database: sql,
		services: [
			servicePair(AGENTS, {
				runtime,
				approvals: { approves: async () => approves },
			}),
			boundIdentity(
				bound,
				`token:${options.toolNames?.dispatch ?? "remote-mcp"}`,
			),
			servicePair(CONVERSATIONS, {
				adopt: async () => undefined,
				register: async (registration) => {
					registered.push(registration);
					const at = new Date();
					return {
						...registration,
						surface: "mcp",
						createdAt: at,
						lastActiveAt: at,
					};
				},
			}),
			{
				key: discord.service.key,
				given: { ...discord.service.given, connection: {} },
			},
		],
	});
	harnesses.push(harness);
	return { harness, runtime, discord, registered };
}

/** An MCP client whose HTTP goes straight into the plugin's routes. */
export async function connect(harness: TestPluginResult, path: string) {
	const routes = harness.contribution.http ?? [];
	const client = new Client({ name: "test", version: "1.0.0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${PUBLIC_URL}${path}`), {
			requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
			fetch: async (input, init) => {
				const request = new Request(String(input), init as RequestInit);
				const route = routes.find((r) =>
					"exact" in r.path
						? r.path.exact === new URL(request.url).pathname
						: new URL(request.url).pathname.startsWith(r.path.prefix),
				);
				if (!route) throw new Error("no route");
				return route.handle(request);
			},
		}),
	);
	return client;
}

export async function relay(
	harness: TestPluginResult,
	message: string,
	sessionId?: string,
) {
	const client = await connect(harness, "/mcp/personal");
	const started = jsonOf(
		await client.callTool({
			name: "agent_dispatch",
			arguments: { message, ...(sessionId ? { sessionId } : {}) },
		}),
	);
	if (started.error) {
		await client.close();
		return { error: started.error as string };
	}
	for (let tries = 0; tries < 100; tries++) {
		const state = jsonOf(
			await client.callTool({
				name: "agent_result",
				arguments: { runId: started.runId },
			}),
		);
		if (state.status !== "working") {
			await client.close();
			return { ...state, sessionId: started.sessionId as string };
		}
		await Bun.sleep(10);
	}
	throw new Error("the run did not finish");
}

export function useRemoteMcpHarness() {
	beforeAll(async () => {
		sql = new SQL(testDatabaseUrl);
	});

	afterAll(async () => {
		await Promise.all(harnesses.map((harness) => harness.stop()));
		await sql.close();
		harnesses.length = 0;
	});
}
