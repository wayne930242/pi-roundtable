import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SQL } from "bun";
import { AGENTS, type ChannelKey, migrateDatabase } from "pi-roundtable";
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
import { REMOTE_MCP_MESSAGES } from "./messages.ts";
import { remoteMcp } from "./remote-mcp-plugin.ts";

const TOKEN = "dispatch-token-for-tests";
const PUBLIC_URL = "https://bot.example.test";
const base = { dispatchToken: TOKEN, publicUrl: PUBLIC_URL };

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

	/** The plugin over a migrated database, with the agent server's runtime and a Discord stand-in. */
	async function boot(
		options: Parameters<typeof remoteMcp>[0],
		runtime: RecordingRuntime = recordingRuntime(),
		approves = false,
	) {
		const plugin = remoteMcp(options);
		await migrateDatabase(testDatabaseUrl, [plugin]);
		const discord = fakeDiscord();
		const harness = await testPlugin(plugin, {
			database: sql,
			services: [
				servicePair(AGENTS, {
					runtime,
					approvals: { approves: async () => approves },
				}),
				{
					key: discord.service.key,
					given: { ...discord.service.given, connection: {} },
				},
			],
		});
		harnesses.push(harness);
		return { harness, runtime, discord };
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

	async function relay(harness: TestPluginResult, message: string) {
		const client = await connect(harness, "/mcp/personal");
		const started = jsonOf(
			await client.callTool({
				name: "agent_dispatch",
				arguments: { message },
			}),
		);
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
		const seen: { channel: ChannelKey; text: string }[] = [];
		const calls: string[] = [];
		const runtime = recordingRuntime();
		const { harness } = await boot(
			{
				...base,
				answer: async (channel, text) => {
					seen.push({ channel, text });
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
	async function grantCommands() {
		const { discord } = await boot(base);
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
});
