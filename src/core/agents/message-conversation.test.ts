import { describe, expect, test } from "bun:test";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import type { ChannelKey, TurnResult } from "../domain/conversation.ts";
import type { AgentTurnScope, TurnRequest } from "../domain/ports.ts";
import { messages } from "../i18n/index.ts";
import { silentLogger } from "../log.ts";
import { ChannelQueue } from "../routing/channel-queue.ts";
import { TEST_OWNER as OWNER, OWNER_SPEAKER } from "../testing/owner.ts";
import { AgentConversations } from "./agent-conversations.ts";
import type { AgentPost } from "./agent-ports.ts";
import type { Agent, PgAgentStore } from "./agent-store.ts";
import { agentRoomKey, discordKey } from "./team-keys.ts";
import { TeamTurns } from "./team-turns.ts";

const agent = (
	name: string,
	displayName: string,
	channelId: string,
): Agent => ({
	name,
	displayName,
	prompt: "",
	avatarPrompt: "",
	channelId,
	status: "active",
});

const AGENTS = [
	agent("coder", "Coder", "4000"),
	agent("infra", "Infrastructure", "2000"),
];

/** The store the turns read, over two agents; each team gets its own record of the conversations. */
const storeOf = (conversations = AgentConversations.memory()) =>
	({
		agent: (name: string) => AGENTS.find((a) => a.name === name),
		activeAgent: (name: string) => {
			const found = AGENTS.find((a) => a.name === name);
			if (!found) throw new Error(`no agent ${name}`);
			return found;
		},
		agentByChannel: (id: string) => AGENTS.find((a) => a.channelId === id),
		group: () => undefined,
		groupByChannel: () => undefined,
		conversations,
	}) as unknown as PgAgentStore;

const discord = (name: string) =>
	discordKey(AGENTS.find((a) => a.name === name)?.channelId ?? "");
const web = (name: string) => agentRoomKey("app", name);
const scopeIn = (name: string, channel: ChannelKey): AgentTurnScope => ({
	name,
	session: channel,
	home: channel,
});

/** A team whose agents each have a Discord channel and a room on the surface `app`. */
function setup(
	answer: (request: TurnRequest) => TurnResult,
	conversations = AgentConversations.memory(),
) {
	const store = storeOf(conversations);
	const turns: TurnRequest[] = [];
	const posts: { channelId: string; post: AgentPost }[] = [];
	const replies: { channel: string; text: string }[] = [];
	const team: TeamTurns = new TeamTurns({
		owner: OWNER,
		entryChannelId: "4000",
		store,
		channels: {
			post: async (channelId, post) => {
				posts.push({ channelId, post });
			},
			interim: () => ({
				post: async () => ({ edit: async () => undefined }),
			}),
		},
		surfaces: {
			roomSurfaces: () => ["app"],
			sendReply: async (channel, reply) => {
				replies.push({ channel, text: reply.chunks.join("") });
			},
			of: () => undefined,
			interim: () => undefined,
		},
		studio: { url: () => "https://x/a.png" },
		runtime: () => ({
			runTurn: async (request) => {
				turns.push(request);
				return answer(request);
			},
			heldActions: async () => undefined,
			startFresh: async () => undefined,
			deleteConversation: async () => undefined,
			contextUsage: () => undefined,
		}),
		selection: () => ({ id: "agent", tools: [], groups: [] }),
		confirmations: { approves: async () => true },
		scorer: { score: async () => undefined },
		queue: new ChannelQueue(),
		startTyping: () => () => undefined,
		showStop: () => () => undefined,
		logger: silentLogger(),
		changed: () => undefined,
	});
	const speak = (channel: ChannelKey, text = "hi") =>
		team.answerOwner(channel, OWNER_SPEAKER, text, text, NO_ATTACHMENTS);
	const settle = async () => {
		for (let i = 0; i < 30; i++) await Bun.sleep(2);
	};
	return { team, turns, posts, replies, speak, settle };
}

/** The (agent, channel) of each turn that ran, in order. */
const ran = (turns: TurnRequest[]) =>
	turns.map((t) => [t.agent?.name, t.channel]);

describe("message_agent picks the target's conversation", () => {
	test("a reminder to an agent lands in the web conversation it was working in, and the answer returns to the sender's Discord channel", async () => {
		let sent: string | undefined;
		const { team, turns, posts, replies, speak, settle } = setup((request) => {
			if (request.agent?.name === "coder" && request.text === "remind infra")
				sent = team.message(
					scopeIn("coder", discord("coder")),
					"infra",
					"the deploy is done",
				);
			return { ok: true, text: `${request.agent?.name} ok` };
		});
		// infra was started in the web app, where the owner and it are still talking.
		await speak(web("infra"), "check the logs");
		await speak(discord("coder"), "remind infra");
		await settle();
		expect(ran(turns)).toEqual([
			["infra", web("infra")],
			["coder", discord("coder")],
			["infra", web("infra")],
			["coder", discord("coder")],
		]);
		expect(turns[2]?.agent?.session).toBe(web("infra"));
		expect(turns[3]?.agent?.session).toBe(discord("coder"));
		expect(sent).toContain(`app conversation (${web("infra")})`);
		// The request is shown in infra's web conversation, the answer in coder's channel.
		expect(replies.map((r) => r.channel)).toContain(web("infra"));
		expect(
			replies.some(
				(r) =>
					r.channel === web("infra") &&
					r.text ===
						messages().messageDelivered("Infrastructure", "the deploy is done"),
			),
		).toBe(true);
		expect(posts.map((p) => p.channelId)).toContain("4000");
		expect(posts.every((p) => p.channelId !== "2000")).toBe(true);
	});

	test("the answer goes back to the conversation the sender wrote from, even when the target answers in another", async () => {
		const { team, turns, replies, posts, speak, settle } = setup((request) => {
			if (request.agent?.name === "coder" && request.text === "ask infra")
				team.message(scopeIn("coder", web("coder")), "infra", "disk?");
			return { ok: true, text: `${request.agent?.name} ok` };
		});
		// infra last worked in Discord.
		await speak(discord("infra"), "hello");
		await speak(web("coder"), "ask infra");
		await settle();
		expect(ran(turns)).toEqual([
			["infra", discord("infra")],
			["coder", web("coder")],
			["infra", discord("infra")],
			["coder", web("coder")],
		]);
		expect(posts.some((p) => p.channelId === "2000")).toBe(true);
		expect(
			replies.some(
				(r) =>
					r.channel === web("coder") &&
					r.text === messages().answerReturned("infra ok"),
			),
		).toBe(true);
	});

	test("with no history the sender's own surface decides: a room's message stays among rooms, a Discord one goes to Discord", async () => {
		for (const [from, to] of [
			[web("coder"), web("infra")],
			[discord("coder"), discord("infra")],
		] as const) {
			const { team, turns, speak, settle } = setup((request) => {
				if (request.agent?.name === "coder" && turns.length === 1)
					team.message(scopeIn("coder", from), "infra", "go");
				return { ok: true, text: "ok" };
			});
			await speak(from);
			await settle();
			expect(ran(turns)[1]).toEqual(["infra", to]);
		}
	});

	test("conversation chooses the target's discord, web, or a key it was shown", async () => {
		const asks: [string | undefined, ChannelKey][] = [
			["discord", discord("infra")],
			["web", web("infra")],
			["app", web("infra")],
			[discord("infra"), discord("infra")],
			[web("infra"), web("infra")],
		];
		for (const [conversation, expected] of asks) {
			const { team, turns, speak, settle } = setup((request) => {
				if (request.agent?.name === "coder" && turns.length === 2)
					team.message(
						scopeIn("coder", discord("coder")),
						"infra",
						"go",
						conversation,
					);
				return { ok: true, text: "ok" };
			});
			// infra last worked in the other one.
			await speak(conversation === "discord" ? web("infra") : discord("infra"));
			await speak(discord("coder"));
			await settle();
			expect(ran(turns)[2]).toEqual(["infra", expected]);
		}
	});

	test("a conversation the target does not have is refused with the ones it has", async () => {
		const { team, speak } = setup((request) => {
			if (request.agent?.name === "coder")
				for (const ask of ["slack", "discord:999", "app:agent.coder"])
					expect(() =>
						team.message(
							scopeIn("coder", discord("coder")),
							"infra",
							"go",
							ask,
						),
					).toThrow(`its conversations: ${discord("infra")}, ${web("infra")}`);
			return { ok: true, text: "ok" };
		});
		const result = await speak(discord("coder"));
		expect(result.ok).toBe(true);
	});

	test("the latest conversation follows the agent's turns, and a group round is none", async () => {
		const conversations = AgentConversations.memory();
		const { speak } = setup(() => ({ ok: true, text: "ok" }), conversations);
		expect(conversations.latest("infra")).toBeUndefined();
		await speak(web("infra"));
		expect(conversations.latest("infra")).toBe(web("infra"));
		await speak(discord("infra"));
		expect(conversations.latest("infra")).toBe(discord("infra"));
	});
});
