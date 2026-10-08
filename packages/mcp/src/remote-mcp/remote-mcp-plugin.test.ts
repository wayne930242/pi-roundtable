import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SQL } from "bun";
import {
	AGENTS,
	type ChannelKey,
	CONVERSATIONS,
	type ConversationRegistration,
	IDENTITY,
	IdentityError,
	migrateDatabase,
	type Speaker,
	type Tier,
} from "pi-roundtable";
import {
	describeDb,
	fakeDiscord,
	servicePair,
	type TestPluginResult,
	testDatabaseUrl,
	testPlugin,
} from "pi-roundtable/testing";
import { fakeInteraction } from "../testing/fake-interaction.ts";
import {
	type RecordingRuntime,
	recordingRuntime,
} from "../testing/recording-runtime.ts";
import { ChannelGrantStore } from "./channel-grants.ts";
import { MEMBER_PERSONA } from "./default-conversation.ts";
import { REMOTE_MCP_MESSAGES, type RemoteMcpMessages } from "./messages.ts";
import { remoteMcp } from "./remote-mcp-plugin.ts";

const TOKEN = "dispatch-token-for-tests";
const PUBLIC_URL = "https://bot.example.test";
const base = { dispatchToken: TOKEN, publicUrl: PUBLIC_URL };

/** The 0.8 texts a single-owner host's remote turns are told, word for word. */
const PERSONA_0_8 =
	"You are the owner's personal assistant. The owner is writing to you through an outside agent over MCP, not on Discord, and each message begins with a note saying so. Answer the owner directly.";
const RELAY_NOTE_0_8 =
	"(The owner wrote this in a personal agent that relays it over MCP, not on Discord. Answer the owner directly, just as you would on Discord; the agent passes your reply back.)";

/** Whom the dispatch token stands for, as `IDENTITY` reads it once the identity plugin linked it. */
interface Bound {
	principal: string;
	name: string;
	tier: Tier;
	/** Throws from `speakerFor`, as for a principal disabled since. */
	refused?: boolean;
	/** The token linked to no one, as a replacement `IDENTITY` may leave it. */
	unlinked?: boolean;
}

const OWNER_BOUND: Bound = { principal: "owner", name: "Owner", tier: "owner" };
const KAI_BOUND: Bound = { principal: "p_kai", name: "Kai", tier: "member" };

/** `IDENTITY` with the token `identity` linked as `bound` says, the primary owner `owner`. */
function boundIdentity(bound: Bound, identity = "token:remote-mcp") {
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

const jsonOf = (result: unknown) =>
	JSON.parse(
		(result as { content: { text: string }[] }).content[0]?.text ?? "{}",
	);

test.each([
	["an empty dispatch token", { dispatchToken: "" }],
	["a public URL that is not https", { publicUrl: "http://bot.example.test" }],
	["a public URL that is not a URL", { publicUrl: "bot" }],
	["a tool name with a space", { toolNames: { dispatch: "ask agent" } }],
	["an empty tool name", { toolNames: { result: "" } }],
	[
		"a tool name over 64 characters",
		{ toolNames: { dispatch: "a".repeat(65) } },
	],
	["two tools with one name", { toolNames: { dispatch: "agent_result" } }],
	[
		"an answer without its claim",
		{ answer: async () => ({ ok: true as const, text: "" }) },
	],
])("refuses %s before the host starts", (_name, change) => {
	expect(() => remoteMcp({ ...base, ...change } as never)).toThrow(
		"remote-mcp",
	);
});

test("declares the dispatch token as an identity, bound to the principal given or the primary owner", () => {
	expect(remoteMcp(base).identities).toEqual([
		{ identity: "token:remote-mcp" },
	]);
	expect(remoteMcp({ ...base, principal: "p_kai" }).identities).toEqual([
		{ identity: "token:remote-mcp", principal: "p_kai" },
	]);
	expect(
		remoteMcp({ ...base, toolNames: { dispatch: "ask_agent" } }).identities,
	).toEqual([{ identity: "token:ask_agent" }]);
});

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("remoteMcp on a plugin harness", () => {
	let sql: SQL;
	const harnesses: TestPluginResult[] = [];

	beforeAll(async () => {
		sql = new SQL(testDatabaseUrl);
	});

	afterAll(async () => {
		await Promise.all(harnesses.map((harness) => harness.stop()));
		await sql.close();
	});

	/**
	 * The plugin over a migrated database, with the agent server's runtime, a Discord stand-in,
	 * `IDENTITY` with the token bound as given, and a registry that records each conversation.
	 */
	async function boot(
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
	async function connect(harness: TestPluginResult, path: string) {
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

	async function relay(
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

	test("the default turn is the bound principal's, in a conversation private to them", async () => {
		const { harness, runtime, registered } = await boot(
			{ ...base, principal: "p_kai" },
			recordingRuntime(),
			false,
			KAI_BOUND,
		);
		const result = await relay(harness, "hi");
		expect(result.status).toBe("completed");
		expect(runtime.turns.at(-1)?.speaker).toEqual({
			id: "p_kai",
			name: "Kai",
			tier: "member",
			principalId: "p_kai",
		});
		expect(registered.at(-1)).toMatchObject({
			key: `mcp:${result.sessionId}`,
			kind: "remote",
			visibility: "private",
			principalId: "p_kai",
		});
	});

	test("bound to an owner, the persona and the relay note are 0.8's word for word; bound to a member, they say someone writes", async () => {
		const owner = await boot(base);
		expect(owner.harness.contribution.personas?.[0]?.prompt()).toBe(
			PERSONA_0_8,
		);
		await relay(owner.harness, "hi");
		expect(owner.runtime.turns.at(-1)?.text).toBe(`${RELAY_NOTE_0_8}\nhi`);
		expect(owner.runtime.turns.at(-1)?.speaker).toMatchObject({
			tier: "owner",
			principalId: "owner",
		});

		const member = await boot(base, recordingRuntime(), false, KAI_BOUND);
		expect(member.harness.contribution.personas?.[0]?.prompt()).toBe(
			MEMBER_PERSONA,
		);
		expect(MEMBER_PERSONA).not.toContain("owner");
		await relay(member.harness, "hi");
		expect(member.runtime.turns.at(-1)?.text).toBe(
			`${REMOTE_MCP_MESSAGES.memberRelayNote}\nhi`,
		);
		expect(REMOTE_MCP_MESSAGES.memberRelayNote).not.toContain("owner");

		// The host's own wording stands for whoever the token stands for.
		const worded = await boot(
			{ ...base, persona: "You are a helper.", messages: { relayNote: "[r]" } },
			recordingRuntime(),
			false,
			KAI_BOUND,
		);
		expect(worded.harness.contribution.personas?.[0]?.prompt()).toBe(
			"You are a helper.",
		);
		await relay(worded.harness, "hi");
		expect(worded.runtime.turns.at(-1)?.text).toBe("[r]\nhi");
	});

	test("a session another principal opened is not found once the token stands for someone else", async () => {
		const owner = await boot(base);
		const opened = await relay(owner.harness, "hi");
		expect(opened.status).toBe("completed");

		const kai = await boot(base, recordingRuntime(), false, KAI_BOUND);
		expect(await relay(kai.harness, "and me?", opened.sessionId)).toEqual({
			error: "SESSION_NOT_FOUND",
		});
		expect(kai.runtime.turns).toEqual([]);
		const own = await relay(kai.harness, "hi");
		expect(own.status).toBe("completed");

		// Bound back, the owner's session goes on, and Kai's is not theirs.
		const again = await boot(base);
		expect(
			(await relay(again.harness, "still there?", opened.sessionId)).status,
		).toBe("completed");
		expect(await relay(again.harness, "and Kai's?", own.sessionId)).toEqual({
			error: "SESSION_NOT_FOUND",
		});
	});

	test("a session 0.8 left, of no principal, is the primary owner's", async () => {
		const id = crypto.randomUUID();
		await sql`INSERT INTO remote_agent_sessions (id) VALUES (${id})`;
		const kai = await boot(base, recordingRuntime(), false, KAI_BOUND);
		expect(await relay(kai.harness, "hi", id)).toEqual({
			error: "SESSION_NOT_FOUND",
		});
		const owner = await boot(base);
		expect((await relay(owner.harness, "hi", id)).status).toBe("completed");
	});

	test("a turn for a principal IDENTITY refuses, such as one disabled since, fails the run", async () => {
		const { harness, runtime } = await boot(base, recordingRuntime(), false, {
			...KAI_BOUND,
			refused: true,
		});
		expect(await relay(harness, "hi")).toMatchObject({
			status: "failed",
			error: REMOTE_MCP_MESSAGES.runFailed,
		});
		expect(runtime.turns).toEqual([]);
	});

	test("the start stops when IDENTITY links the dispatch token to no one", async () => {
		expect(
			boot(base, recordingRuntime(), false, {
				...OWNER_BOUND,
				unlinked: true,
			}),
		).rejects.toThrow(
			"remote-mcp: token:remote-mcp, the dispatch token's identity, is linked to no principal",
		);
	});

	test("the default turn confirms held actions when the relayed message approves them", async () => {
		const runtime = recordingRuntime();
		runtime.pendingConfirmation = () => ({ held: true }) as never;
		const { harness } = await boot(base, runtime, true);
		const result = await relay(harness, "yes, go ahead");
		expect(result.status).toBe("completed");
		expect(runtime.turns.at(-1)).toMatchObject({
			kind: "remote",
			confirmed: true,
		});
	});

	test("a message that does not approve leaves held actions held", async () => {
		const runtime = recordingRuntime();
		runtime.pendingConfirmation = () => ({ held: true }) as never;
		const { harness } = await boot(base, runtime, false);
		await relay(harness, "what is pending?");
		expect(runtime.turns.at(-1)?.confirmed).toBeUndefined();
	});

	test("the tools take the host's names, and the default descriptions name each other", async () => {
		const toolNames = {
			dispatch: "ask_owner_agent",
			result: "owner_agent_reply",
		};
		const { harness } = await boot({ ...base, toolNames });
		const client = await connect(harness, "/mcp/personal");
		const tools = (await client.listTools()).tools;
		expect(tools.map((tool) => tool.name)).toEqual([
			"ask_owner_agent",
			"owner_agent_reply",
		]);
		expect(tools[0]?.description).toContain("poll owner_agent_reply");
		expect(tools[1]?.description).toContain("started by ask_owner_agent");
		const started = jsonOf(
			await client.callTool({
				name: "ask_owner_agent",
				arguments: { message: "hi" },
			}),
		);
		expect(started.runId).toBeString();
		await client.close();
	});

	test("the relay note and tool descriptions take the host's wording", async () => {
		const runtime = recordingRuntime();
		const { harness } = await boot(
			{
				...base,
				messages: {
					relayNote: "[relayed]",
					dispatchDescription: () => "Ask away.",
				},
			},
			runtime,
		);
		await relay(harness, "hi");
		expect(runtime.turns.at(-1)?.text).toBe("[relayed]\nhi");
		const client = await connect(harness, "/mcp/personal");
		const dispatch = (await client.listTools()).tools.find(
			(tool) => tool.name === "agent_dispatch",
		);
		expect(dispatch?.description).toBe("Ask away.");
		await client.close();
	});

	test("a host that runs the turns itself supplies the answer and the claim", async () => {
		const seen: { channel: ChannelKey; text: string; speaker: Speaker }[] = [];
		const calls: string[] = [];
		const runtime = recordingRuntime();
		const { harness } = await boot(
			{
				...base,
				answer: async (channel, text, speaker) => {
					seen.push({ channel, text, speaker });
					return { ok: true, text: "from the host" };
				},
				claim: {
					startFresh: async () => {
						calls.push("fresh");
						return "owner";
					},
					deleteConversation: async (channel) => {
						calls.push(`delete ${channel}`);
					},
				},
			},
			runtime,
		);
		const result = await relay(harness, "hello");
		expect(result).toMatchObject({
			status: "completed",
			text: "from the host",
		});
		expect(seen[0]?.text).toContain("\nhello");
		// Whom the turn is for: the principal the token stands for.
		expect(seen[0]?.speaker).toEqual({
			id: "owner",
			name: "Owner",
			tier: "owner",
			principalId: "owner",
		});
		// The core's runtime ran nothing, and no persona was contributed for it.
		expect(runtime.turns).toEqual([]);
		expect(harness.contribution.personas ?? []).toEqual([]);

		const channel = `mcp:${result.sessionId}` as const;
		expect(await harness.conversations.startFresh(channel)).toBe("owner");
		await Bun.sleep(0);
		expect(await harness.conversations.deleteConversation(channel)).toBe(
			"deleted",
		);
		expect(calls).toEqual(["fresh", `delete ${channel}`]);
		// Without a `stop` or `background` hook the claim has neither.
		expect(harness.conversations.stop(channel)).toBe(false);
		const claim = harness.contribution.channels?.[0];
		expect(claim?.background).toBeUndefined();
		expect(claim?.stop).toBeUndefined();
	});

	test("the persona is the host's text, or the neutral default", async () => {
		const custom = await boot({ ...base, persona: "You are Ada's helper." });
		expect(custom.harness.contribution.personas?.[0]).toMatchObject({
			kind: "remote",
		});
		expect(custom.harness.contribution.personas?.[0]?.prompt()).toBe(
			"You are Ada's helper.",
		);
	});

	test("adds /<root> mcp with its five subcommands", async () => {
		const { discord } = await boot(base);
		const root = discord
			.compose()
			.commands.find((command) => command.name === "roundtable");
		const group = root?.options?.find((option) => option.name === "mcp");
		expect(
			(group as { options?: { name: string }[] } | undefined)?.options?.map(
				(option) => option.name,
			),
		).toEqual(["authorize", "grants", "revoke", "describe", "token"]);
	});

	test("the grant commands answer the owner, and refuse the cases that need a server", async () => {
		const { discord } = await boot(base);
		const [added] = discord.added().slice(-1);
		if (!added) throw new Error("the plugin added no command");
		const run = async (options: Parameters<typeof fakeInteraction>[0]) => {
			const { interaction, replies } = fakeInteraction({
				user: "owner",
				...options,
			});
			await added.module.handle(interaction as never);
			return replies.text();
		};
		await sql`DELETE FROM discord_mcp_bundles`;
		expect(await run({ group: "mcp", sub: "grants" })).toContain(
			REMOTE_MCP_MESSAGES.noGrants,
		);
		expect(
			await run({
				group: "mcp",
				sub: "authorize",
				strings: { bundle: "team" },
			}),
		).toContain(REMOTE_MCP_MESSAGES.useInServer);
		expect(
			await run({
				group: "mcp",
				sub: "revoke",
				guild: true,
				strings: { bundle: "team" },
			}),
		).toContain(REMOTE_MCP_MESSAGES.noBundle("team", "roundtable"));
	});

	/** The plugin's grant command module and a runner for interactions against it. */
	async function grantCommands(messages?: Partial<RemoteMcpMessages>) {
		const { discord } = await boot({ ...base, messages });
		const [added] = discord.added().slice(-1);
		if (!added) throw new Error("the plugin added no command");
		return async (options: Parameters<typeof fakeInteraction>[0]) => {
			const { interaction, replies } = fakeInteraction({
				user: "owner",
				...options,
			});
			await added.module.handle(interaction as never);
			return replies;
		};
	}

	/** A bundle with one granted channel, as a finished `authorize` leaves it. */
	async function seedBundle(name: string, tokenHash: string) {
		const grants = await ChannelGrantStore.attach(sql);
		await sql`DELETE FROM discord_mcp_bundles WHERE name = ${name}`;
		const { bundle } = await grants.ensureBundle(name, tokenHash, ["read"]);
		await grants.save({
			bundleId: bundle.id,
			channelId: "111",
			guildId: "900",
			operations: ["read"],
			displayName: "Lobby",
			description: "",
			guildName: "Example Server",
			channelName: "lobby",
			authorizedBy: "100000000000000001",
			authorizedAt: new Date(),
		});
		return { grants, bundle };
	}

	test("describe changes what the agent sees, and revoke removes the channel", async () => {
		const run = await grantCommands();
		const { grants, bundle } = await seedBundle("team", "hash-team");
		const described = await run({
			group: "mcp",
			sub: "describe",
			guild: true,
			strings: { bundle: "team", description: "Planning talk" },
		});
		expect(described.text()).toContain(REMOTE_MCP_MESSAGES.described);
		expect((await grants.grant(bundle.id, "111"))?.description).toBe(
			"Planning talk",
		);
		const revoked = await run({
			group: "mcp",
			sub: "revoke",
			guild: true,
			strings: { bundle: "team" },
		});
		expect(revoked.text()).toContain(REMOTE_MCP_MESSAGES.revoked("team"));
		expect(await grants.grant(bundle.id, "111")).toBeUndefined();
	});

	test("replacing a bundle's URL asks first, then the old URL stops working", async () => {
		const run = await grantCommands();
		const { grants, bundle } = await seedBundle("rotate", "hash-old");
		const asked = await run({
			group: "mcp",
			sub: "token",
			guild: true,
			strings: { bundle: "rotate" },
		});
		expect(asked.text()).toContain(REMOTE_MCP_MESSAGES.rotateAsk("rotate"));
		const [confirm, cancel] = asked.customIds();
		expect(confirm).toStartWith("rtmcp:grant:rotate:");

		// Someone else pressing the button gets nothing.
		const stranger = await run({
			group: "mcp",
			sub: "",
			button: confirm,
			user: "other",
		});
		expect(stranger.text()).toContain(REMOTE_MCP_MESSAGES.expiredTitle);
		expect((await grants.bundleByTokenHash("hash-old"))?.id).toBe(bundle.id);

		const done = await run({ group: "mcp", sub: "", button: confirm });
		expect(done.text()).toContain(REMOTE_MCP_MESSAGES.rotatedTitle);
		expect(done.text()).toContain(`${PUBLIC_URL}/mcp/discord/`);
		expect(await grants.bundleByTokenHash("hash-old")).toBeUndefined();

		// The pending choice is consumed: pressing again, or cancelling, finds it gone.
		const again = await run({ group: "mcp", sub: "", button: cancel });
		expect(again.text()).toContain(REMOTE_MCP_MESSAGES.expiredTitle);
	});

	test("cancelling a pending replacement changes nothing", async () => {
		const run = await grantCommands();
		const { grants, bundle } = await seedBundle("keep", "hash-keep");
		const asked = await run({
			group: "mcp",
			sub: "token",
			guild: true,
			strings: { bundle: "keep" },
		});
		const cancel = asked.customIds()[1];
		const cancelled = await run({ group: "mcp", sub: "", button: cancel });
		expect(cancelled.text()).toContain(REMOTE_MCP_MESSAGES.cancelledTitle);
		expect((await grants.bundleByTokenHash("hash-keep"))?.id).toBe(bundle.id);
	});

	test("the two not-in-bundle refusals and the two name options have their own wording", async () => {
		const messages = {
			notInBundle: () => "DESCRIBE-MISSING",
			revokeNotInBundle: () => "REVOKE-MISSING",
			agentNameOption: "AUTHORIZE-NAME",
			describeAgentNameOption: "DESCRIBE-NAME",
		};
		const { discord } = await boot({ ...base, messages });
		const group = discord
			.compose()
			.commands.find((command) => command.name === "roundtable")
			?.options?.find((option) => option.name === "mcp") as unknown as {
			options: {
				name: string;
				options: { name: string; description: string }[];
			}[];
		};
		const nameOf = (sub: string) =>
			group.options
				.find((option) => option.name === sub)
				?.options.find((option) => option.name === "name")?.description;
		expect(nameOf("authorize")).toBe("AUTHORIZE-NAME");
		expect(nameOf("describe")).toBe("DESCRIBE-NAME");

		const run = await grantCommands(messages);
		await seedBundle("words", "hash-words");
		const strings = { bundle: "words", channel_id: "222", description: "x" };
		const described = await run({
			group: "mcp",
			sub: "describe",
			guild: true,
			strings,
		});
		expect(described.text()).toContain("DESCRIBE-MISSING");
		const revoked = await run({
			group: "mcp",
			sub: "revoke",
			guild: true,
			strings,
		});
		expect(revoked.text()).toContain("REVOKE-MISSING");
	});

	test("the grants list takes the host's label separator, list separator and audit status", async () => {
		const run = await grantCommands({
			labelSeparator: " | ",
			listSeparator: " + ",
			auditStatus: (status) => `<${status}>`,
		});
		const { grants, bundle } = await seedBundle("labels", "hash-labels");
		await grants.save({
			bundleId: bundle.id,
			channelId: "111",
			guildId: "900",
			operations: ["read", "send"],
			displayName: "Lobby",
			description: "",
			guildName: "Example Server",
			channelName: "lobby",
			authorizedBy: "100000000000000001",
			authorizedAt: new Date(),
		});
		const text = (
			await run({ group: "mcp", sub: "grants", guild: true })
		).text();
		expect(text).toContain("- **Lobby** | Example Server › #lobby");
		expect(text).toMatch(/Allowed: .+ \+ .+ \(ID 111\)/);
		expect(text).toContain("`authorize` <succeeded>");
	});
});
