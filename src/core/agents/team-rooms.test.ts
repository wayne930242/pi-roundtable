import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatSurface } from "../contract/surface.ts";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import type { OutboundReply, TurnResult } from "../domain/conversation.ts";
import { AgentRunError } from "../domain/errors.ts";
import type { AgentTurnScope, TurnRequest } from "../domain/ports.ts";
import { messages } from "../i18n/index.ts";
import { silentLogger } from "../log.ts";
import { attachReplyFile } from "../reply-files.ts";
import { ChannelQueue } from "../routing/channel-queue.ts";
import { surfacePort } from "../routing/surface-port.ts";
import { TEST_OWNER as OWNER, OWNER_SPEAKER } from "../testing/owner.ts";
import { FakeSurfaceThreads } from "../testing/surface-threads.ts";
import { FakeThreadHost, fakeThreads } from "../testing/thread-host.ts";
import { DispatchThreads } from "../threads/dispatch-threads.ts";
import type { AgentPost } from "./agent-ports.ts";
import type { Agent, PgAgentStore } from "./agent-store.ts";
import { agentRoomKey } from "./team-keys.ts";
import type { TeamTurnsOptions } from "./team-turn-types.ts";
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

/** The store methods turns in rooms read, over two agents. */
const store = {
	agent: (name: string) => AGENTS.find((a) => a.name === name),
	activeAgent: (name: string) => {
		const found = AGENTS.find((a) => a.name === name);
		if (!found) throw new Error(`no agent ${name}`);
		return found;
	},
	agentByChannel: (id: string) => AGENTS.find((a) => a.channelId === id),
	group: () => undefined,
	groupByChannel: () => undefined,
} as unknown as PgAgentStore;

/** A surface that hosts rooms and records what is sent to it. */
function roomSurface(
	rooms: readonly string[] = ["app"],
	supportsFiles = false,
) {
	const replies: { channel: string; reply: OutboundReply }[] = [];
	/** Interim posts as `channel name/agent: text`, edits included. */
	const interims: string[] = [];
	const port: NonNullable<TeamTurnsOptions["surfaces"]> = {
		roomSurfaces: () => rooms,
		// Like the surface port: a surface that does not declare files refuses a reply that has them.
		sendReply: async (channel, reply) => {
			if (reply.files?.length && !supportsFiles)
				throw new Error("the surface does not support reply files");
			replies.push({ channel, reply });
		},
		of: () => ({ supportsFiles }) as ChatSurface,
		interim: (channel, as) =>
			as === undefined
				? undefined
				: {
						post: async (text) => {
							interims.push(`${channel} ${as.name}/${as.agent}: ${text}`);
							return {
								edit: async (change) =>
									void interims.push(
										`${channel} ${as.name}/${as.agent}: edit ${change}`,
									),
							};
						},
					},
	};
	return { port, replies, interims };
}

function setup(
	answer: (request: TurnRequest) => TurnResult | Promise<TurnResult>,
	surfaces: TeamTurnsOptions["surfaces"],
	host = new FakeThreadHost(),
	given?: DispatchThreads,
) {
	const posts: { channelId: string; post: AgentPost }[] = [];
	const discordInterims: string[] = [];
	const turns: TurnRequest[] = [];
	const threads = given ?? fakeThreads(host).threads;
	const team = new TeamTurns({
		owner: OWNER,
		entryChannelId: "4000",
		store,
		channels: {
			post: async (channelId, post) => {
				posts.push({ channelId, post });
			},
			interim: (channelId, as) => ({
				post: async (text) => {
					discordInterims.push(`${channelId} ${as.name}: ${text}`);
					return { edit: async () => undefined };
				},
			}),
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
		threads,
		...(surfaces ? { surfaces } : {}),
	});
	return { team, host, posts, discordInterims, turns };
}

describe("agent rooms", () => {
	const room = agentRoomKey("app", "coder");
	const ask = (team: TeamTurns) =>
		team.answerOwner(room, OWNER_SPEAKER, "hi", "hi", NO_ATTACHMENTS);

	test("an owner message in a room runs in the room's own conversation and replies through the surface under the agent's name", async () => {
		const { port, replies } = roomSurface();
		const { team, turns, posts } = setup(
			() => ({ ok: true, text: "done" }),
			port,
		);
		await ask(team);
		expect(turns).toHaveLength(1);
		expect(turns[0]?.channel).toBe(room);
		expect(turns[0]?.agent).toEqual({
			name: "coder",
			session: room,
			home: room,
		});
		expect(replies).toEqual([
			{
				channel: room,
				reply: { chunks: ["done"], author: { name: "Coder", agent: "coder" } },
			},
		]);
		// Never the Discord channel's webhook, the agent's own or any other.
		expect(posts).toEqual([]);
	});

	test("a room on a surface without files is not offered reply files, so its reply is not lost", async () => {
		const { port, replies } = roomSurface();
		let refused = "";
		const { team } = setup(() => {
			try {
				attachReplyFile({ name: "a.txt", data: new Uint8Array([1]) });
			} catch (error) {
				refused = error instanceof Error ? error.message : String(error);
			}
			return { ok: true, text: "done" };
		}, port);
		await ask(team);
		expect(refused).toContain("does not support reply files");
		expect(replies.map((r) => r.reply.chunks)).toEqual([["done"]]);
	});

	test("a room on a surface that supports files may attach reply files", async () => {
		const { port, replies } = roomSurface(["app"], true);
		const { team } = setup(() => {
			attachReplyFile({ name: "a.txt", data: new Uint8Array([1]) });
			return { ok: true, text: "done" };
		}, port);
		await ask(team);
		expect(replies[0]?.reply.files?.map((f) => f.name)).toEqual(["a.txt"]);
	});

	test("a failed room turn tells the room, not Discord", async () => {
		const { port, replies } = roomSurface();
		const { team, posts } = setup(
			() => ({ ok: false, error: new AgentRunError("boom") }),
			port,
		);
		await ask(team);
		expect(replies).toHaveLength(1);
		expect(replies[0]?.reply.author?.agent).toBe("coder");
		expect(posts).toEqual([]);
	});

	test("interim posts of a room turn go through the surface with the agent as author", async () => {
		const { port, replies, interims } = roomSurface();
		const { team, discordInterims } = setup(async (request) => {
			const message = await request.interim?.post("a proposal");
			await message?.edit("-# bash");
			expect(replies).toEqual([]);
			return { ok: true, text: "done" };
		}, port);
		await ask(team);
		expect(interims).toEqual([
			`${room} Coder/coder: a proposal`,
			`${room} Coder/coder: edit -# bash`,
		]);
		expect(discordInterims).toEqual([]);
	});

	test("a surface without interim posts leaves the room turn with none", async () => {
		const { port } = roomSurface();
		let seen: unknown = "unset";
		const { team } = setup(
			(request) => {
				seen = request.interim;
				return { ok: true, text: "done" };
			},
			{ ...port, interim: () => undefined },
		);
		await ask(team);
		expect(seen).toBeUndefined();
	});

	test("a room turn's progress reaches the room's surface, and a Discord channel's turn gets none", async () => {
		const { port } = roomSurface();
		const shown: string[] = [];
		const surfaces: TeamTurnsOptions["surfaces"] = {
			...port,
			progress: async (channel, event) => {
				shown.push(`${channel} ${event.type}`);
			},
		};
		const seen: unknown[] = [];
		const { team } = setup((request) => {
			seen.push(request.progress);
			request.progress?.({ type: "text", delta: "so far" });
			return { ok: true, text: "done" };
		}, surfaces);
		await ask(team);
		await team.answerOwner(
			"discord:4000",
			OWNER_SPEAKER,
			"hi",
			"hi",
			NO_ATTACHMENTS,
		);
		expect(shown).toEqual([`${room} text`]);
		expect(seen[1]).toBeUndefined();
	});

	test("a background turn in a room replies in the room", async () => {
		const { port, replies } = roomSurface();
		const { team, turns } = setup(() => ({ ok: true, text: "tick" }), port);
		await team.answerBackground(room, OWNER_SPEAKER, "scheduled");
		expect(turns[0]?.agent?.session).toBe(room);
		expect(replies.map((r) => [r.channel, r.reply.chunks])).toEqual([
			[room, ["tick"]],
		]);
	});

	test("a reply finishing after its agent was archived is dropped", async () => {
		const { port, replies } = roomSurface();
		const coder = AGENTS.find((a) => a.name === "coder") as Agent;
		const { team } = setup(() => {
			coder.status = "archived";
			return { ok: true, text: "late" };
		}, port);
		try {
			await ask(team);
		} finally {
			coder.status = "active";
		}
		expect(replies).toEqual([]);
	});

	test("a room key of a surface that hosts no rooms, or of no surface port, is not an agent's", async () => {
		for (const surfaces of [roomSurface([]).port, undefined]) {
			const { team } = setup(() => ({ ok: true, text: "x" }), surfaces);
			await expect(ask(team)).rejects.toThrow(/no agent owns/);
		}
	});

	test("message_agent from a room whose surface hosts no threads stays among the surface's rooms: no Discord post, no thread, the answer returns to the sender's room", async () => {
		const { port, replies } = roomSurface();
		const host = new FakeThreadHost();
		const sender: AgentTurnScope = { name: "coder", session: room, home: room };
		const { team, turns, posts } = setup(
			(request) => {
				if (request.agent?.name === "coder" && turns.length === 1)
					team.message(sender, "infra", "check the disk");
				return {
					ok: true,
					text: request.agent?.name === "infra" ? "disk 80%" : "ok",
				};
			},
			port,
			host,
		);
		await ask(team);
		for (let i = 0; i < 30; i++) await Bun.sleep(2);
		const infraRoom = agentRoomKey("app", "infra");
		expect(
			turns.map((t) => [t.agent?.name, t.channel, t.agent?.session]),
		).toEqual([
			["coder", room, room],
			["infra", infraRoom, infraRoom],
			["coder", room, room],
		]);
		expect(posts).toEqual([]);
		expect(host.opened).toEqual([]);
		const said = (channel: string) =>
			replies
				.filter((r) => r.channel === channel)
				.map((r) => [r.reply.author?.agent, r.reply.chunks.join("")]);
		expect(said(infraRoom)).toEqual([
			[
				"coder",
				messages().messageDelivered("Infrastructure", "check the disk"),
			],
			["infra", "disk 80%"],
		]);
		expect(said(room)).toEqual([
			["coder", "ok"],
			["infra", messages().answerReturned("disk 80%")],
			["coder", "ok"],
		]);
	});

	test("message_agent from a room whose surface hosts threads opens the exchange's thread there and the answer goes into it", async () => {
		const { port, replies } = roomSurface();
		const appThreads = new FakeSurfaceThreads();
		const app: ChatSurface = {
			surface: "app",
			agentRooms: true,
			start: async () => undefined,
			sendReply: async () => undefined,
			threads: appThreads,
		};
		const threads = new DispatchThreads({
			surfaces: surfacePort(() => [app]),
			ledgerPath: join(
				mkdtempSync(join(tmpdir(), "roundtable-room-threads-")),
				"ledger.json",
			),
			logger: silentLogger(),
		});
		const sender: AgentTurnScope = { name: "coder", session: room, home: room };
		const { team, turns, posts } = setup(
			(request) => {
				if (request.agent?.name === "coder" && turns.length === 1)
					team.message(sender, "infra", "check the disk");
				return {
					ok: true,
					text: request.agent?.name === "infra" ? "disk 80%" : "ok",
				};
			},
			port,
			undefined,
			threads,
		);
		await ask(team);
		for (let i = 0; i < 30; i++) await Bun.sleep(2);
		const infraRoom = agentRoomKey("app", "infra");
		const thread = "app:thread.1";
		expect(appThreads.opened).toEqual([
			{ parent: room, name: "→ Infrastructure", id: "thread.1" },
		]);
		expect(appThreads.closed).toEqual(["thread.1"]);
		expect(posts).toEqual([]);
		const said = (channel: string) =>
			replies
				.filter((r) => r.channel === channel)
				.map((r) => [r.reply.author?.agent, r.reply.chunks.join("")]);
		// The request and the answer are in the thread, each under its speaker's name.
		expect(said(thread)).toEqual([
			[
				"coder",
				messages().messageDelivered("Infrastructure", "check the disk"),
			],
			["infra", messages().answerReturned("disk 80%")],
		]);
		expect(said(infraRoom)).toEqual([
			[
				"coder",
				messages().messageDelivered("Infrastructure", "check the disk"),
			],
			["infra", "disk 80%"],
		]);
		// The sender's room keeps its own replies; the answer woke its next turn with the thread named.
		expect(said(room)).toEqual([
			["coder", "ok"],
			["coder", "ok"],
		]);
		expect(turns[2]?.text).toContain("→ Infrastructure");
	});
});
