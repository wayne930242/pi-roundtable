import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConversations } from "../agents/agent-conversations.ts";
import type { StoredOutboxEntry } from "../agents/agent-outbox.ts";
import type { Agent, PgAgentStore } from "../agents/agent-store.ts";
import {
	agentRoomKey,
	discordKey,
	groupSeatChannel,
} from "../agents/team-keys.ts";
import { TeamTurns } from "../agents/team-turns.ts";
import type { ChatSurface } from "../contract/surface.ts";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import { DelegationError } from "../domain/errors.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import { silentLogger } from "../log.ts";
import { sessionNotify } from "../modules/notify/session-notify.ts";
import { ChannelQueue } from "../routing/channel-queue.ts";
import { surfacePort } from "../routing/surface-port.ts";
import type { SessionContext } from "../sessions.ts";
import { TEST_OWNER as OWNER, OWNER_SPEAKER } from "../testing/owner.ts";
import { registeredTools } from "../testing/run-tool.ts";
import { DispatchThreads } from "../threads/dispatch-threads.ts";
import { runChannelFor } from "./delivery-router.ts";
import {
	type DirectChannelProvider,
	directChannelsPort,
} from "./direct-channels.ts";

/**
 * The cross-surface contract: every outbound feature started from a web conversation reaches only
 * the web app, and every one started from Discord reaches only Discord. Both surfaces are fakes
 * that record everything sent to them; a mirror (the web app's push echo of a notice, to the same
 * person) is recorded apart, since a provider declares it.
 */

type Surface = "discord" | "app";
const SURFACES: readonly Surface[] = ["discord", "app"];

interface Received {
	discord: string[];
	app: string[];
	mirrored: string[];
}

const fresh = (): Received => ({ discord: [], app: [], mirrored: [] });
const surfaceOfKey = (key: ChannelKey): Surface =>
	key.startsWith("discord:") ? "discord" : "app";
const other = (surface: Surface): Surface =>
	surface === "discord" ? "app" : "discord";

/** A chat surface that records each reply, prompt, and thread on it. */
function recordingSurface(name: Surface, received: Received): ChatSurface {
	const log = (what: string) => void received[name].push(what);
	let threads = 0;
	return {
		surface: name,
		agentRooms: name === "app",
		start: async () => undefined,
		sendReply: async (channel, reply) =>
			log(`reply ${channel}: ${reply.chunks.join("")}`),
		prompts: (channel) => {
			log(`prompts ${channel}`);
			return undefined;
		},
		threads: {
			open: async (parent, name) => {
				threads += 1;
				log(`thread ${parent}: ${name}`);
				return { id: `t${threads}`, mention: `#t${threads}` };
			},
			post: async (thread, text) => log(`thread post ${thread}: ${text}`),
			close: async (thread) => log(`thread close ${thread}`),
		},
	};
}

/** Ada's direct channels on both surfaces: Discord's direct messages first, as a host contributes them. */
function providers(received: Received): DirectChannelProvider[] {
	return [
		{
			name: "discord",
			surface: "discord",
			label: "a direct message on Discord",
			reaches: async (id) => (id === "ada" ? "discord:dm-ada" : undefined),
			deliver: async (id, text) =>
				void received.discord.push(`dm ${id}: ${text}`),
		},
		{
			name: "web:app",
			surface: "app",
			label: "a notice in the web app",
			reaches: async (id) => (id === "ada" ? "app:home" : undefined),
			deliver: async (id, text) =>
				void received.app.push(`notice ${id}: ${text}`),
			mirror: async (id, text) =>
				void received.mirrored.push(`push ${id}: ${text}`),
		},
	];
}

function host(received: Received) {
	const port = surfacePort(() =>
		SURFACES.map((name) => recordingSurface(name, received)),
	);
	const direct = directChannelsPort(() => providers(received), port);
	return { port, direct };
}

/** A shared conversation's session in `channel`, as notify reads it, where Ada speaks. */
const sessionIn = (channel: ChannelKey) =>
	({
		homeChannel: channel,
		turnChannel: channel,
		conversation: { visibility: "shared" },
		speaker: () => ({ ...OWNER_SPEAKER, principalId: "ada" }),
		addressee: OWNER,
	}) as unknown as SessionContext;

async function notifyFrom(
	direct: ReturnType<typeof directChannelsPort>,
	channel: ChannelKey,
	text: string,
): Promise<void> {
	const factory = sessionNotify({
		directChannels: direct,
		owner: { ...OWNER, id: "ada" },
		onlyOwnerNotified: async () => false,
		logger: silentLogger(),
	})(sessionIn(channel));
	const [tool] = await registeredTools(factory);
	const result = await tool?.execute("call", { text });
	expect(result?.isError).not.toBe(true);
}

// ── The agent team, for message_agent and its replay ───────────────────────

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
	agent("academic", "Academic", "2000"),
];
const discordOf = (name: string) =>
	discordKey(AGENTS.find((a) => a.name === name)?.channelId ?? "");
const roomOf = (name: string) => agentRoomKey("app", name);
const placeOf = (name: string, surface: Surface) =>
	surface === "discord" ? discordOf(name) : roomOf(name);
const scopeIn = (name: string, channel: ChannelKey): AgentTurnScope => ({
	name,
	session: channel,
	home: channel,
});

function team(
	received: Received,
	outbox: StoredOutboxEntry[] = [],
	onTurn: (team: TeamTurns, text: string, agent: string) => void = () => {},
) {
	const claimed = new Set<number>();
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
		conversations: AgentConversations.memory(),
		outbox: {
			keep: async () => undefined,
			pending: async () => outbox,
			claim: async (id: number) => !claimed.has(id) && Boolean(claimed.add(id)),
		},
	} as unknown as PgAgentStore;
	const turns: TeamTurns = new TeamTurns({
		owner: OWNER,
		entryChannelId: "4000",
		store,
		channels: {
			post: async (channelId, post) =>
				void received.discord.push(
					`post discord:${channelId}: ${post.chunks?.join("") ?? ""}`,
				),
			interim: () => ({
				post: async () => ({ edit: async () => undefined }),
			}),
		},
		surfaces: {
			roomSurfaces: () => ["app"],
			sendReply: async (channel, reply) =>
				void received[surfaceOfKey(channel)].push(
					`reply ${channel}: ${reply.chunks.join("")}`,
				),
			of: () => undefined,
			interim: () => undefined,
		},
		studio: { url: () => "https://x/a.png" },
		runtime: () => ({
			runTurn: async (request) => {
				onTurn(turns, request.text, request.agent?.name ?? "");
				return { ok: true, text: `${request.agent?.name} ok` };
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
	return turns;
}

const settle = async () => {
	for (let i = 0; i < 30; i++) await Bun.sleep(2);
};

// ── The matrix ─────────────────────────────────────────────────────────────

/** Each outbound feature, run from a conversation on `surface`. */
const FEATURES: Record<
	string,
	(received: Received, surface: Surface) => Promise<void>
> = {
	reply: async (received, surface) => {
		const { port } = host(received);
		await port.sendReply(placeOf("academic", surface), { chunks: ["done"] });
	},
	notify: async (received, surface) => {
		const { direct } = host(received);
		await notifyFrom(direct, placeOf("academic", surface), "ping");
	},
	"schedule run and its report": async (received, surface) => {
		const { port, direct } = host(received);
		const origin = placeOf("academic", surface);
		// Schedule #43: made in the conversation, it runs there, and its turn notifies.
		const run = await runChannelFor(
			{ surfaces: port, directChannels: direct, takesBackground: () => true },
			origin,
			"ada",
			(m) => new DelegationError(m),
		);
		expect(run).toBe(origin);
		await port.sendReply(run, { chunks: ["the scheduled report"] });
		await notifyFrom(direct, run, "your reminder");
	},
	"message_agent request and answer cards": async (received, surface) => {
		const turns = team(received, [], (t, text, name) => {
			if (name === "coder" && text === "ask academic")
				t.message(
					scopeIn("coder", placeOf("coder", surface)),
					"academic",
					"status?",
				);
		});
		// The target last worked on the other surface, which "most recent" would follow.
		await turns.answerOwner(
			placeOf("academic", other(surface)),
			OWNER_SPEAKER,
			"hello",
			"hello",
			NO_ATTACHMENTS,
		);
		await settle();
		received.discord.length = 0;
		received.app.length = 0;
		await turns.answerOwner(
			placeOf("coder", surface),
			OWNER_SPEAKER,
			"ask academic",
			"ask academic",
			NO_ATTACHMENTS,
		);
		await settle();
	},
	"ask_user card": async (received, surface) => {
		const { port } = host(received);
		port.prompts(placeOf("academic", surface));
	},
	"timeout card": async (received, surface) => {
		const { port } = host(received);
		// The timeout card is a prompt in the turn's own channel, as ask_user's.
		port.prompts(placeOf("academic", surface));
	},
	"coding or dispatch report": async (received, surface) => {
		const { port } = host(received);
		const ledger = join(
			tmpdir(),
			`cross-surface-${surface}-${Date.now()}.json`,
		);
		const threads = new DispatchThreads({
			surfaces: port,
			ledgerPath: ledger,
			logger: silentLogger(),
		});
		const thread = await threads.open(
			placeOf("academic", surface),
			"repo #1",
			"Task: fix",
		);
		expect(thread).toBeDefined();
		await thread?.close("the report");
		rmSync(ledger, { force: true });
	},
	"start-over of a group seat": async (received, surface) => {
		const { port } = host(received);
		// A seat outside its turn, as after a start-over, posts in the group's place on its own surface.
		const seat = groupSeatChannel(
			{ name: "council", channelId: "7000" },
			{ home: placeOf("academic", surface) },
		);
		await port.sendReply(seat, { chunks: ["started over"] });
	},
	"follow-up after restart replay": async (received, surface) => {
		const turns = team(received, [
			{
				id: 1,
				kind: "message",
				sender: "coder",
				target: "academic",
				channel: placeOf("academic", surface),
				origin: placeOf("coder", surface),
				text: "kept request",
				speaker: OWNER_SPEAKER,
				messages: 1,
			},
			{
				id: 2,
				kind: "reply",
				sender: "coder",
				target: "academic",
				channel: placeOf("coder", surface),
				text: "kept answer",
				speaker: OWNER_SPEAKER,
				messages: 1,
			},
		]);
		await turns.replayMessages();
		await settle();
	},
};

describe("every outbound feature stays on the surface of the conversation it came from", () => {
	for (const [feature, run] of Object.entries(FEATURES))
		for (const surface of SURFACES)
			test(`${feature}, from ${surface === "app" ? "a web" : "a Discord"} conversation`, async () => {
				const received = fresh();
				await run(received, surface);
				expect(received[surface].length).toBeGreaterThan(0);
				expect(received[other(surface)]).toEqual([]);
			});

	test("a notice from Discord is echoed to the same person's phone only by the web app's declared mirror", async () => {
		const received = fresh();
		await notifyFrom(host(received).direct, discordOf("academic"), "ping");
		expect(received.mirrored).toEqual(["push ada: ping"]);
		expect(received.app).toEqual([]);
	});
});
