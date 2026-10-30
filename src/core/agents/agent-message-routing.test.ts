import { describe, expect, test } from "bun:test";
import type { ResolvedRouting } from "../config/routing.ts";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import type { ChannelKey, TurnResult } from "../domain/conversation.ts";
import type { AgentTurnScope, TurnRequest } from "../domain/ports.ts";
import { silentLogger } from "../log.ts";
import { ChannelQueue } from "../routing/channel-queue.ts";
import { TEST_OWNER as OWNER, OWNER_SPEAKER } from "../testing/owner.ts";
import { AgentConversations } from "./agent-conversations.ts";
import type { Agent, PgAgentStore } from "./agent-store.ts";
import { Routes } from "./routes.ts";
import { agentRoomKey, discordKey } from "./team-keys.ts";
import { TeamTurns } from "./team-turns.ts";

const agent = (name: string, channelId: string): Agent => ({
	name,
	displayName: name,
	prompt: "",
	avatarPrompt: "",
	channelId,
	status: "active",
});
const AGENTS = [agent("coder", "4000"), agent("infra", "2000")];

const discord = (name: string) =>
	discordKey(AGENTS.find((a) => a.name === name)?.channelId ?? "");
const web = (name: string) => agentRoomKey("app", name);
const scopeIn = (name: string, channel: ChannelKey): AgentTurnScope => ({
	name,
	session: channel,
	home: channel,
});

/** A team whose agents each have a Discord channel and a room on `app`, under the given routing. */
function setup(
	answer: (request: TurnRequest) => TurnResult,
	routing?: ResolvedRouting,
) {
	const conversations = AgentConversations.memory();
	const store = {
		agent: (name: string) => AGENTS.find((a) => a.name === name),
		activeAgent: (name: string) => AGENTS.find((a) => a.name === name),
		agentByChannel: (id: string) => AGENTS.find((a) => a.channelId === id),
		group: () => undefined,
		groupByChannel: () => undefined,
		conversations,
	} as unknown as PgAgentStore;
	const turns: TurnRequest[] = [];
	const posted: string[] = [];
	const team: TeamTurns = new TeamTurns({
		owner: OWNER,
		entryChannelId: "4000",
		store,
		routes: new Routes({
			routing,
			store,
			roomSurfaces: () => ["app"],
			latest: (name) => conversations.latest(name),
		}),
		channels: {
			post: async (channelId) => void posted.push(`discord:${channelId}`),
			interim: () => ({ post: async () => ({ edit: async () => undefined }) }),
		},
		surfaces: {
			roomSurfaces: () => ["app"],
			sendReply: async (channel) => void posted.push(channel),
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
	return { team, turns, posted, speak, settle };
}

const ran = (turns: TurnRequest[]) =>
	turns.map((t) => [t.agent?.name, t.channel]);

const pinned: ResolvedRouting = {
	agents: { infra: { primary: "app", agentMessage: "primary" } },
	places: {},
};

describe("routing and the work a person is waiting on", () => {
	const remind = (routing?: ResolvedRouting) => {
		const f = setup((request) => {
			if (request.agent?.name === "coder" && request.text === "remind infra")
				f.team.message(
					scopeIn("coder", discord("coder")),
					"infra",
					"the deploy is done",
				);
			return { ok: true, text: `${request.agent?.name} ok` };
		}, routing);
		return f;
	};

	test("without routing a message to an agent that last ran in Discord lands in Discord, as before", async () => {
		const f = remind();
		await f.speak(discord("infra"), "check the logs");
		await f.speak(discord("coder"), "remind infra");
		await f.settle();
		expect(ran(f.turns)).toEqual([
			["infra", discord("infra")],
			["coder", discord("coder")],
			["infra", discord("infra")],
			["coder", discord("coder")],
		]);
	});

	test("a rule that pins messages to the primary place delivers there, and the answer still returns to the sender", async () => {
		const f = remind(pinned);
		await f.speak(discord("infra"), "check the logs");
		await f.speak(discord("coder"), "remind infra");
		await f.settle();
		expect(ran(f.turns)).toEqual([
			["infra", discord("infra")],
			["coder", discord("coder")],
			// R6 is routed: the delivery follows the primary place, not where infra last ran.
			["infra", web("infra")],
			// R7 is not: the answer wakes the sender where the sender wrote from.
			["coder", discord("coder")],
		]);
		expect(f.posted).toContain(web("infra"));
	});

	test("an owner's message is answered where it was written, whatever the primary place", async () => {
		const f = setup(() => ({ ok: true, text: "done" }), pinned);
		await f.speak(discord("infra"), "from discord");
		await f.speak(web("infra"), "from the web");
		expect(ran(f.turns)).toEqual([
			["infra", discord("infra")],
			["infra", web("infra")],
		]);
		expect(f.posted).toEqual([`discord:2000`, web("infra")]);
	});
});
