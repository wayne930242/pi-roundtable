import { describe, expect, test } from "bun:test";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import type {
	PendingConfirmation,
	TurnResult,
} from "../domain/conversation.ts";
import { AgentRunError } from "../domain/errors.ts";
import type { AgentTurnScope, TurnRequest } from "../domain/ports.ts";
import { messages } from "../i18n/index.ts";
import { silentLogger } from "../log.ts";
import { attachReplyFile } from "../reply-files.ts";
import { ChannelQueue } from "../routing/channel-queue.ts";
import { TEST_OWNER as OWNER, OWNER_SPEAKER } from "../testing/owner.ts";
import { toolTiers } from "../tool-tiers.ts";
import { AgentConversations } from "./agent-conversations.ts";
import type { AgentPost } from "./agent-ports.ts";
import type { Agent, AgentGroup, PgAgentStore } from "./agent-store.ts";
import { discordKey } from "./team-keys.ts";
import { TeamTurns } from "./team-turns.ts";

const agent = (name: string, channelId: string): Agent => ({
	name,
	displayName: name === "infra" ? "Infrastructure" : "Coordinator",
	prompt: "",
	avatarPrompt: "",
	channelId,
	status: "active",
});

const AGENTS = [agent("coordinator", "1000"), agent("infra", "2000")];
const GROUP: AgentGroup = {
	name: "ops",
	displayName: "Ops",
	channelId: "3000",
	members: ["coordinator", "infra"],
	host: "coordinator",
	status: "active",
};

/** The store methods messages between agents read, over two agents and one group. */
const store = {
	agent: (name: string) => AGENTS.find((a) => a.name === name),
	activeAgent: (name: string) => {
		const found = AGENTS.find((a) => a.name === name);
		if (!found) throw new Error(`no agent ${name}`);
		return found;
	},
	agentByChannel: (id: string) => AGENTS.find((a) => a.channelId === id),
	group: (name: string) => (name === GROUP.name ? GROUP : undefined),
	groupByChannel: (id: string) => (id === GROUP.channelId ? GROUP : undefined),
	conversations: AgentConversations.memory(),
} as unknown as PgAgentStore;

const coordinator: AgentTurnScope = {
	name: "coordinator",
	session: discordKey("1000"),
	home: discordKey("1000"),
};

function setup(
	answer: (request: TurnRequest) => TurnResult | Promise<TurnResult>,
	held?: PendingConfirmation,
) {
	const posts: { channelId: string; post: AgentPost }[] = [];
	/** Interim posts as `channelId name: text`, edits included. */
	const interims: string[] = [];
	const turns: TurnRequest[] = [];
	/** The replies the judge was asked to read as approvals. */
	const judged: string[] = [];
	const queue = new ChannelQueue();
	// The agent tools' tiers are the agent server plugin's to declare; this table has the one the tests use.
	const tiers = toolTiers();
	tiers.declare("test", { agent_create: "admin" });
	const team = new TeamTurns({
		owner: OWNER,
		toolTiers: tiers,
		entryChannelId: "1000",
		store,
		channels: {
			post: async (channelId, post) => {
				posts.push({ channelId, post });
			},
			interim: (channelId, as) => ({
				post: async (text) => {
					interims.push(`${channelId} ${as.name}: ${text}`);
					return {
						edit: async (change) =>
							void interims.push(`${channelId} ${as.name}: edit ${change}`),
					};
				},
			}),
		},
		studio: { url: () => "https://x/a.png" },
		runtime: () => ({
			runTurn: async (request) => {
				turns.push(request);
				return answer(request);
			},
			heldActions: async () => held,
			startFresh: async () => undefined,
			deleteConversation: async () => undefined,
			contextUsage: () => undefined,
		}),
		selection: () => ({ id: "agent", tools: [], groups: [] }),
		confirmations: {
			approves: async (_pending, reply) => {
				judged.push(reply);
				return true;
			},
		},
		scorer: { score: async () => undefined },
		queue,
		startTyping: () => () => undefined,
		showStop: () => () => undefined,
		logger: silentLogger(),
		changed: () => undefined,
	});
	/** Posts in a channel other than cards, as `name: text`. */
	const texts = (channelId: string) =>
		posts
			.filter((p) => p.channelId === channelId && !p.post.intercom)
			.map((p) => `${p.post.name}: ${p.post.chunks.join("")}`);
	/** The cards of messages between agents in a channel, as `name kind peer: text`. */
	const cards = (channelId: string) =>
		posts.flatMap((p) =>
			p.channelId === channelId && p.post.intercom
				? [
						`${p.post.name} ${p.post.intercom.kind} ${p.post.intercom.peer.name}: ${p.post.intercom.text}`,
					]
				: [],
		);
	return { team, posts, interims, turns, texts, cards, judged };
}

/** Runs a coordinator turn, whose model sends the message, and waits for the chain to settle. */
async function run(team: TeamTurns): Promise<void> {
	await team.answerBackground(discordKey("1000"), OWNER_SPEAKER, "go");
	for (let i = 0; i < 30; i++) await Bun.sleep(2);
}

describe("agent reply files", () => {
	test("turn attachments use the agent post and its identity, including files-only replies", async () => {
		const file = { name: "drawing.png", data: new Uint8Array([1, 2]) };
		for (const text of ["Here is the drawing.", ""]) {
			const { team, posts } = setup(() => {
				attachReplyFile(file);
				return { ok: true, text };
			});
			await team.answerBackground(discordKey("1000"), OWNER_SPEAKER, "draw");
			expect(posts).toEqual([
				{
					channelId: "1000",
					post: {
						name: "Coordinator",
						avatarUrl: "https://x/a.png",
						chunks: text ? [text] : [],
						files: [file],
					},
				},
			]);
		}
	});

	test("failed and stopped agent turns post no attachments", async () => {
		for (const stopped of [false, true]) {
			const { team, posts } = setup(() => {
				attachReplyFile({ name: "drawing.png", data: new Uint8Array([1]) });
				return {
					ok: false,
					error: new Error("failed"),
					...(stopped ? { stopped: true as const } : {}),
				};
			});
			await team.answerBackground(discordKey("1000"), OWNER_SPEAKER, "draw");
			expect(posts[0]?.post.files).toBeUndefined();
		}
	});
});

describe("interim posts", () => {
	test("an agent turn's interim posts go out under its name before its reply", async () => {
		const { team, posts, interims } = setup(async (request) => {
			const message = await request.interim?.post("a proposal");
			await message?.edit("-# bash");
			expect(posts).toEqual([]);
			return { ok: true, text: "done" };
		});
		await team.answerBackground(discordKey("1000"), OWNER_SPEAKER, "go");
		expect(interims).toEqual([
			"1000 Coordinator: a proposal",
			"1000 Coordinator: edit -# bash",
		]);
		expect(posts.map((p) => p.post.chunks)).toEqual([["done"]]);
	});
});

describe("message_agent cards", () => {
	test("the request and the answer show as cards in the sender's channel, and no thread opens", async () => {
		const { team, texts, cards, turns, posts } = setup((request) => {
			if (request.agent?.name === "coordinator" && turns.length === 1)
				team.message(coordinator, "infra", "check the disk\nand the logs");
			return {
				ok: true,
				text: request.agent?.name === "infra" ? "disk 80%" : "ok",
			};
		});
		await run(team);
		expect(cards("1000")).toEqual([
			"Coordinator sent infra: check the disk\nand the logs",
			"Infrastructure answered infra: disk 80%",
		]);
		// A surface without cards reads the card's heading and its whole text.
		const sent = posts.find((p) => p.post.intercom?.kind === "sent");
		expect(sent?.post.chunks).toEqual([
			`${messages().intercomSent("Infrastructure")}\ncheck the disk\nand the logs`,
		]);
		expect(posts.some((p) => p.post.threadId !== undefined)).toBe(false);
		// The target's own channel is unchanged; the sender's channel holds its own replies besides.
		expect(texts("2000")).toEqual([
			`Coordinator: ${messages().messageDelivered("Infrastructure", "check the disk\nand the logs")}`,
			"Infrastructure: disk 80%",
		]);
		expect(texts("1000")).toEqual(["Coordinator: ok", "Coordinator: ok"]);
		const followUp = turns.at(-1);
		expect(followUp?.channel).toBe(discordKey("1000"));
		expect(followUp?.text).toContain("disk 80%");
		expect(followUp?.text).not.toContain("thread");
		// Only the answer's follow-up is a report turn, which may ask the owner on cards.
		expect(turns.map((t) => [t.agent?.name, t.interactive])).toEqual([
			["coordinator", undefined],
			["infra", undefined],
			["coordinator", true],
		]);
	});

	test("a report turn in an agent's channel may ask on cards; a schedule's may not", async () => {
		const { team, turns } = setup(() => ({ ok: true, text: "ok" }));
		await team.answerBackground(discordKey("1000"), OWNER_SPEAKER, "scheduled");
		await team.answerBackground(
			discordKey("1000"),
			OWNER_SPEAKER,
			"report",
			true,
		);
		expect(turns.map((t) => t.interactive)).toEqual([undefined, true]);
	});

	test("a failed or stopped answer shows as a failure card, and the sender hears why", async () => {
		const { team, cards, turns } = setup((request) => {
			if (request.agent?.name === "coordinator" && turns.length === 1)
				team.message(coordinator, "infra", "x");
			return request.agent?.name === "infra"
				? {
						ok: false,
						error: new AgentRunError("stopped by the owner"),
						stopped: true,
					}
				: { ok: true, text: "ok" };
		});
		await run(team);
		expect(cards("1000")).toEqual([
			"Coordinator sent infra: x",
			"Infrastructure failed infra: stopped by the owner",
		]);
		expect(turns.at(-1)?.text).toContain("could not answer");
		expect(turns.at(-1)?.text).toContain("stopped by the owner");
		expect(turns.at(-1)?.text).not.toContain("thread");
	});

	test("a group round's messages show their cards in the group channel", () => {
		const { team } = setup(() => ({ ok: true, text: "" }));
		expect(team.turnChannel({ ...coordinator, group: "ops" })).toBe(
			discordKey("3000"),
		);
		expect(team.turnChannel(coordinator)).toBe(discordKey("1000"));
	});
});

describe("unattended turns", () => {
	test("a schedule's turn with nothing to say posts nothing, and a failed one still posts", async () => {
		const { team, posts } = setup(() => ({ ok: true, text: "" }));
		await team.answerBackground(discordKey("1000"), OWNER_SPEAKER, "scheduled");
		expect(posts).toEqual([]);
		// A failure is still posted: only an empty answer is quiet.
		const failed = setup(() => ({ ok: false, error: new Error("boom") }));
		await failed.team.answerBackground(
			discordKey("1000"),
			OWNER_SPEAKER,
			"scheduled",
		);
		expect(failed.posts).toHaveLength(1);
	});

	test("a schedule's own time limit reaches the turn, and only that turn", async () => {
		const { team, turns } = setup(() => ({ ok: true, text: "ok" }));
		await team.answerBackground(
			discordKey("1000"),
			OWNER_SPEAKER,
			"limited",
			false,
			90 * 60_000,
		);
		await team.answerBackground(discordKey("1000"), OWNER_SPEAKER, "plain");
		expect(turns.map((t) => t.timeLimitMs)).toEqual([90 * 60_000, undefined]);
	});

	test("an agent that has nothing to answer a message sends nothing back and wakes nobody", async () => {
		const { team, texts, cards, turns } = setup((request) => {
			if (request.agent?.name === "coordinator" && turns.length === 1)
				team.message(coordinator, "infra", "anything new?");
			return {
				ok: true,
				text: request.agent?.name === "infra" ? "" : "ok",
			};
		});
		await run(team);
		expect(turns.map((t) => t.agent?.name)).toEqual(["coordinator", "infra"]);
		// Only the request's card: a quiet answer posts none.
		expect(cards("1000")).toEqual(["Coordinator sent infra: anything new?"]);
		expect(texts("2000")).toEqual([
			`Coordinator: ${messages().messageDelivered("Infrastructure", "anything new?")}`,
		]);
	});
});

describe("speakers", () => {
	test("a message chain keeps the speaker who started it through every hop", async () => {
		const admin = {
			id: "2",
			name: "Ada",
			tier: "admin",
			principalId: "2",
		} as const;
		const { team, turns } = setup((request) => {
			if (request.agent?.name === "coordinator" && turns.length === 1)
				team.message(coordinator, "infra", "check the disk");
			return { ok: true, text: "ok" };
		});
		await team.answerBackground(discordKey("1000"), admin, "go");
		for (let i = 0; i < 30; i++) await Bun.sleep(2);
		expect(turns.map((t) => [t.agent?.name, t.speaker])).toEqual([
			["coordinator", admin],
			["infra", admin],
			["coordinator", admin],
		]);
	});
});

describe("approvals", () => {
	const shell: PendingConfirmation = {
		selectionId: "general",
		heldAt: new Date(),
		calls: [{ tool: "bash", input: "{}", action: "run a command" }],
	};
	const answer = () => ({ ok: true, text: "ok" }) as const;
	const reply = (
		team: TeamTurns,
		tier: "owner" | "admin" | "member",
	): Promise<unknown> =>
		team.answerOwner(
			discordKey("1000"),
			{ id: "2", name: "Ada", tier, principalId: "2" },
			"yes, run it",
			"yes, run it",
			NO_ATTACHMENTS,
		);

	test("a speaker whose tier holds the held tool approves it", async () => {
		const { team, turns, judged } = setup(answer, shell);
		await reply(team, "owner");
		expect(judged).toEqual(["yes, run it"]);
		expect(turns[0]?.confirmed).toBe(true);
	});

	test("a lower tier is not asked to approve, so the held action stays held", async () => {
		const { team, turns, judged } = setup(answer, shell);
		await reply(team, "admin");
		await reply(team, "member");
		expect(judged).toEqual([]);
		expect(turns.map((t) => t.confirmed)).toEqual([undefined, undefined]);
	});

	test("an admin approves what an admin may use in their own turn", async () => {
		const held: PendingConfirmation = {
			...shell,
			speakerId: "2",
			calls: [{ tool: "agent_create", input: "{}", action: "create an agent" }],
		};
		const { team, turns } = setup(answer, held);
		await reply(team, "admin");
		expect(turns[0]?.confirmed).toBe(true);
	});

	test("another admin cannot approve what an admin's turn held", async () => {
		const held: PendingConfirmation = {
			...shell,
			speakerId: "3",
			calls: [{ tool: "agent_create", input: "{}", action: "create an agent" }],
		};
		const { team, turns, judged } = setup(answer, held);
		await reply(team, "admin");
		expect(judged).toEqual([]);
		expect(turns[0]?.confirmed).toBeUndefined();
	});

	test("what nobody's or the owner's turn held is the owner's to approve", async () => {
		const held: PendingConfirmation = {
			...shell,
			calls: [{ tool: "agent_create", input: "{}", action: "create an agent" }],
		};
		const admin = setup(answer, held);
		await reply(admin.team, "admin");
		expect(admin.judged).toEqual([]);
		const owner = setup(answer, { ...held, speakerId: "3" });
		await reply(owner.team, "owner");
		expect(owner.turns[0]?.confirmed).toBe(true);
	});

	test("a member admitted at first contact approves, by message from their Discord identity, what their scheduled turn held", async () => {
		// The schedule's turn ran as their principal, whose id is not their Discord id.
		const held: PendingConfirmation = {
			...shell,
			speakerId: "p_01JKAI",
			principalId: "p_01JKAI",
			calls: [{ tool: "agent_create", input: "{}", action: "create an agent" }],
		};
		const { team, turns } = setup(answer, held);
		await team.answerOwner(
			discordKey("1000"),
			{
				id: "966666600000000003",
				name: "Kai",
				tier: "admin",
				principalId: "p_01JKAI",
			},
			"yes, run it",
			"yes, run it",
			NO_ATTACHMENTS,
		);
		expect(turns[0]?.confirmed).toBe(true);
	});

	test("the turn's speaker whose tier was lowered since cannot approve", async () => {
		const held: PendingConfirmation = {
			...shell,
			speakerId: "2",
			calls: [{ tool: "agent_create", input: "{}", action: "create an agent" }],
		};
		const { team, judged } = setup(answer, held);
		await reply(team, "member");
		expect(judged).toEqual([]);
	});

	test("a held call that needs a higher tier than its tool's, such as saving a script that sends mail, waits for that tier", async () => {
		const held: PendingConfirmation = {
			...shell,
			calls: [
				{
					tool: "agent_create",
					input: "{}",
					action: "save a script that sends mail",
					minTier: "owner",
				},
			],
		};
		const admin = setup(answer, held);
		await reply(admin.team, "admin");
		expect(admin.judged).toEqual([]);
		const owner = setup(answer, held);
		await reply(owner.team, "owner");
		expect(owner.turns[0]?.confirmed).toBe(true);
	});

	describe("a held call that names its approvers", () => {
		const held = (approverIds: string[]): PendingConfirmation => ({
			...shell,
			speakerId: "2",
			principalId: "p_sam",
			calls: [
				{
					tool: "agent_create",
					input: "{}",
					action: "create an agent",
					approverIds,
				},
			],
		});
		const as = (
			team: TeamTurns,
			principalId: string,
			tier: "owner" | "admin" | "member",
		) =>
			team.answerOwner(
				discordKey("1000"),
				{ id: `d_${principalId}`, name: principalId, tier, principalId },
				"yes, run it",
				"yes, run it",
				NO_ATTACHMENTS,
			);

		test("a named approver confirms it by message", async () => {
			const { team, turns, judged } = setup(answer, held(["p_ada"]));
			await as(team, "p_ada", "admin");
			expect(judged).toEqual(["yes, run it"]);
			expect(turns[0]?.confirmed).toBe(true);
		});

		test("another principal at the same tier cannot, and is not asked to", async () => {
			const { team, turns, judged } = setup(answer, held(["p_ada"]));
			await as(team, "p_bob", "admin");
			expect(judged).toEqual([]);
			expect(turns[0]?.confirmed).toBeUndefined();
		});

		test("the speaker whose turn held it cannot unless named", async () => {
			const { team, turns, judged } = setup(answer, held(["p_ada"]));
			await as(team, "p_sam", "admin");
			expect(judged).toEqual([]);
			expect(turns[0]?.confirmed).toBeUndefined();
			const named = setup(answer, held(["p_sam"]));
			await as(named.team, "p_sam", "admin");
			expect(named.turns[0]?.confirmed).toBe(true);
		});

		test("an owner still confirms it, also when no one is named", async () => {
			for (const approverIds of [["p_ada"], []]) {
				const { team, turns } = setup(answer, held(approverIds));
				await as(team, "p_boss", "owner");
				expect(turns[0]?.confirmed).toBe(true);
			}
		});

		test("an empty set leaves it to the owners", async () => {
			const { team, turns, judged } = setup(answer, held([]));
			await as(team, "p_sam", "admin");
			await as(team, "p_ada", "admin");
			expect(judged).toEqual([]);
			expect(turns.map((t) => t.confirmed)).toEqual([undefined, undefined]);
		});

		test("a named approver whose tier no longer holds the tool cannot", async () => {
			const { team, judged } = setup(answer, held(["p_ada"]));
			await as(team, "p_ada", "member");
			expect(judged).toEqual([]);
			const tier: PendingConfirmation = {
				...held(["p_ada"]),
				calls: [
					{
						tool: "agent_create",
						input: "{}",
						action: "create an agent",
						minTier: "owner",
						approverIds: ["p_ada"],
					},
				],
			};
			const high = setup(answer, tier);
			await as(high.team, "p_ada", "admin");
			expect(high.judged).toEqual([]);
		});

		test("a pending record with no calls is still the owners' and its speaker's alone", async () => {
			const empty: PendingConfirmation = { ...held(["p_ada"]), calls: [] };
			const named = setup(answer, empty);
			await as(named.team, "p_ada", "admin");
			await as(named.team, "p_bob", "admin");
			expect(named.judged).toEqual([]);
			const speaker = setup(answer, empty);
			await as(speaker.team, "p_sam", "admin");
			expect(speaker.judged).toEqual(["yes, run it"]);
		});

		test("a call that names none keeps its speaker as its approver beside a call that does", async () => {
			const mixed: PendingConfirmation = {
				...shell,
				speakerId: "2",
				principalId: "p_sam",
				calls: [
					{ tool: "agent_create", input: "{}", action: "create an agent" },
					{
						tool: "agent_create",
						input: '{"a":1}',
						action: "create another",
						approverIds: ["p_ada"],
					},
				],
			};
			// Neither the speaker nor the named approver may release both calls alone.
			const { team, judged } = setup(answer, mixed);
			await as(team, "p_sam", "admin");
			await as(team, "p_ada", "admin");
			expect(judged).toEqual([]);
		});
	});
});
