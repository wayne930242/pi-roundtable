import { expect, test } from "bun:test";
import type { ChannelKey, Speaker } from "pi-roundtable";
import { describeDb } from "pi-roundtable/testing";
import { recordingRuntime } from "../testing/recording-runtime.ts";
import {
	base,
	boot,
	connect,
	jsonOf,
	KAI_BOUND,
	OWNER_BOUND,
	PERSONA_0_8,
	RELAY_NOTE_0_8,
	relay,
	sql,
	useRemoteMcpHarness,
} from "../testing/remote-mcp-fixture.ts";
import { MEMBER_PERSONA } from "./default-conversation.ts";
import { REMOTE_MCP_MESSAGES } from "./messages.ts";
import { remoteMcp } from "./remote-mcp-plugin.ts";

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
describeDb("remoteMcp on a plugin harness turns and wording", () => {
	useRemoteMcpHarness();

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
		runtime.heldActions = async () => ({ held: true }) as never;
		const { harness } = await boot(base, runtime, true);
		const result = await relay(harness, "yes, go ahead");
		expect(result.status).toBe("completed");
		expect(runtime.turns.at(-1)).toMatchObject({
			kind: "remote",
			confirmed: true,
		});
	});

	test("the default turn finds the actions a restart left held in the store, which pendingConfirmation does not know yet", async () => {
		const runtime = recordingRuntime();
		const asked: string[] = [];
		let restored = false;
		runtime.pendingConfirmation = () =>
			restored ? ({ held: true } as never) : undefined;
		runtime.heldActions = async (channel) => {
			asked.push(channel);
			restored = true;
			return { held: true } as never;
		};
		const { harness } = await boot(base, runtime, true);
		const result = await relay(harness, "yes, go ahead");
		expect(result.status).toBe("completed");
		expect(asked).toHaveLength(1);
		expect(runtime.turns.at(-1)).toMatchObject({ confirmed: true });
	});

	test("a message that does not approve leaves held actions held", async () => {
		const runtime = recordingRuntime();
		runtime.heldActions = async () => ({ held: true }) as never;
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
});
