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
import { FakeThreadHost, fakeThreads } from "../testing/thread-host.ts";
import { toolTiers } from "../tool-tiers.ts";
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
} as unknown as PgAgentStore;

const coordinator: AgentTurnScope = {
	name: "coordinator",
	session: discordKey("1000"),
	home: discordKey("1000"),
};

function setup(
	answer: (request: TurnRequest) => TurnResult | Promise<TurnResult>,
	host = new FakeThreadHost(),
	withThreads = true,
	held?: PendingConfirmation,
) {
	const posts: { channelId: string; post: AgentPost }[] = [];
	/** Interim posts as `channelId name: text`, edits included. */
	const interims: string[] = [];
	const turns: TurnRequest[] = [];
	/** The replies the judge was asked to read as approvals. */
	const judged: string[] = [];
	const { threads } = fakeThreads(host);
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
		...(withThreads ? { threads } : {}),
	});
	/** Posts in a channel, or in one of its threads, as `name: text`. */
	const texts = (channelId: string, threadId?: string) =>
		posts
			.filter((p) => p.channelId === channelId && p.post.threadId === threadId)
			.map((p) => `${p.post.name}: ${p.post.chunks.join("")}`);
	return { team, host, posts, interims, turns, texts, judged };
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

describe("message_agent threads", () => {
	test("the exchange goes in a thread of the sender's channel, archived before the sender's follow-up", async () => {
		let archivedAtFollowUp: string[] | undefined;
		const host = new FakeThreadHost();
		const { team, texts, turns } = setup((request) => {
			if (request.agent?.name === "coordinator" && turns.length === 1)
				team.message(coordinator, "infra", "check the disk");
			if (request.agent?.name === "coordinator" && turns.length > 1)
				archivedAtFollowUp = [...host.closed];
			return {
				ok: true,
				text: request.agent?.name === "infra" ? "disk 80%" : "ok",
			};
		}, host);
		await run(team);
		expect(host.opened).toEqual([
			{ parentId: "1000", name: "→ Infrastructure", id: "900" },
		]);
		expect(host.lines.get("1000")).toBe(
			messages().threadStarted("→ Infrastructure", "<#900>"),
		);
		expect(texts("1000", "900")).toEqual([
			`Coordinator: ${messages().messageDelivered("Infrastructure", "check the disk")}`,
			`Infrastructure: ${messages().answerReturned("disk 80%")}`,
		]);
		// The target's own channel is unchanged; the sender's channel holds only its own replies.
		expect(texts("2000")).toEqual([
			`Coordinator: ${messages().messageDelivered("Infrastructure", "check the disk")}`,
			"Infrastructure: disk 80%",
		]);
		expect(texts("1000")).toEqual(["Coordinator: ok", "Coordinator: ok"]);
		expect(archivedAtFollowUp).toEqual(["900"]);
		const followUp = turns.at(-1);
		expect(followUp?.channel).toBe(discordKey("1000"));
		expect(followUp?.text).toContain("in the thread <#900>");
		expect(followUp?.text).toContain("disk 80%"); // Only the answer's follow-up is a report turn, which may ask the owner on cards.
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

	test("a failed or stopped answer is reported in the thread, which is archived", async () => {
		const { team, host, turns } = setup((request) => {
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
		expect(host.textsIn("900")).toEqual([
			messages().agentNoReply("stopped by the owner"),
		]);
		expect(host.closed).toEqual(["900"]);
		expect(turns.at(-1)?.text).toContain("could not answer");
		expect(turns.at(-1)?.text).toContain("<#900>");
	});

	test("without a thread the answer comes back in the sender's channel as before", async () => {
		const host = new FakeThreadHost();
		host.failOpen = true;
		const { team, texts, turns } = setup((request) => {
			if (request.agent?.name === "coordinator" && turns.length === 1)
				team.message(coordinator, "infra", "x");
			return { ok: true, text: `${request.agent?.name} ok` };
		}, host);
		await run(team);
		expect(texts("1000")).toContain(
			`Infrastructure: ${messages().answerReturned("infra ok")}`,
		);
		expect(turns.at(-1)?.text).not.toContain("thread");
	});

	test("a group round's dispatches open their threads in the group channel", () => {
		const { team } = setup(() => ({ ok: true, text: "" }), undefined, false);
		expect(team.turnChannel({ ...coordinator, group: "ops" })).toBe(
			discordKey("3000"),
		);
		expect(team.turnChannel(coordinator)).toBe(discordKey("1000"));
	});
});

describe("speakers", () => {
	test("a message chain keeps the speaker who started it through every hop", async () => {
		const admin = { id: "2", name: "Ada", tier: "admin" } as const;
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
			{ id: "2", name: "Ada", tier },
			"yes, run it",
			"yes, run it",
			NO_ATTACHMENTS,
		);

	test("a speaker whose tier holds the held tool approves it", async () => {
		const { team, turns, judged } = setup(answer, undefined, true, shell);
		await reply(team, "owner");
		expect(judged).toEqual(["yes, run it"]);
		expect(turns[0]?.confirmed).toBe(true);
	});

	test("a lower tier is not asked to approve, so the held action stays held", async () => {
		const { team, turns, judged } = setup(answer, undefined, true, shell);
		await reply(team, "admin");
		await reply(team, "member");
		expect(judged).toEqual([]);
		expect(turns.map((t) => t.confirmed)).toEqual([undefined, undefined]);
	});

	test("an admin approves what an admin may use", async () => {
		const held: PendingConfirmation = {
			...shell,
			calls: [{ tool: "agent_create", input: "{}", action: "create an agent" }],
		};
		const { team, turns } = setup(answer, undefined, true, held);
		await reply(team, "admin");
		expect(turns[0]?.confirmed).toBe(true);
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
		const admin = setup(answer, undefined, true, held);
		await reply(admin.team, "admin");
		expect(admin.judged).toEqual([]);
		const owner = setup(answer, undefined, true, held);
		await reply(owner.team, "owner");
		expect(owner.turns[0]?.confirmed).toBe(true);
	});
});
