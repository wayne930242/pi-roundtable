import { afterEach, expect, test } from "bun:test";
import type { InboundMessage } from "./core/contract/channels.ts";
import type { AgentRuntime } from "./core/contract/runtime.ts";
import type { ChatSurface } from "./core/contract/surface.ts";
import type { OutboundReply } from "./core/domain/conversation.ts";
import type { RoundtablePlugin } from "./core/plugin.ts";
import { AGENTS } from "./core/services.ts";
import { describeDb } from "./core/testing/database.ts";
import { type TestHost, testHost } from "./core/testing/test-host.ts";

const hosts: TestHost[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.stop();
});

/** A runtime that answers each turn with its text, naming the conversation the turn ran in. */
const echo: AgentRuntime = {
	runTurn: async (request) => ({
		ok: true,
		text: `echo ${request.agent?.session ?? request.channel}: ${request.text}`,
	}),
	steer: async () => false,
	stop: () => false,
	startFresh: async () => undefined,
	deleteConversation: async () => undefined,
	pendingConfirmation: () => undefined,
	heldActions: async () => undefined,
	recentTranscript: async () => [],
};

const guide = {
	name: "guide",
	displayName: "Guide",
	prompt: "You guide the owner.",
	avatarPrompt: "A friendly guide",
};

/**
 * A chat surface `app` that hosts agent rooms, as pi-roundtable-web does: it records what it is
 * sent, and `say` delivers an owner's message to a room as the surface's own credential.
 */
function appSurface() {
	const replies: { channel: string; reply: OutboundReply }[] = [];
	let deliver: ((message: InboundMessage) => void) | undefined;
	const surface: ChatSurface = {
		surface: "app",
		agentRooms: true,
		start: async (delivery) => {
			deliver = delivery;
		},
		sendReply: async (channel, reply) => void replies.push({ channel, reply }),
	};
	const plugin: RoundtablePlugin = {
		name: "app",
		identities: [{ identity: "token:app-owner" }],
		setup: () => ({ surfaces: [surface] }),
	};
	const say = (channel: string, text: string, messageId = "m1") =>
		deliver?.({
			channel: channel as InboundMessage["channel"],
			messageId,
			actor: { provider: "token", subject: "app-owner", name: "Ada" },
			authorId: "app-owner",
			authorName: "Ada",
			authorIsBot: false,
			isDirect: false,
			mentionsBot: false,
			repliesToBot: false,
			text,
			attachments: [],
		});
	return { plugin, replies, say };
}

const until = async (done: () => boolean, what: string) => {
	const deadline = Date.now() + 10_000;
	while (!done()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(10);
	}
};

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("an agent team on a host without Discord", () => {
	test("boots with a room surface, names the first seed the coordinator, and answers a room message there", async () => {
		const app = appSurface();
		const host = await testHost({
			discord: false,
			runtime: echo,
			config: { agents: [guide] },
			plugins: [app.plugin],
		});
		hosts.push(host);
		const { team } = host.context.services.get(AGENTS);
		await until(() => team.coordinator() === "guide", "the seed agents");
		expect(team.coordinator()).toBe("guide");
		expect(team.guildId).toBe("local");
		expect(team.roomsOf("guide")).toEqual(["app:agent.guide"]);
		expect(team.owns("app:agent.guide")).toBe("agent");
		app.say("app:agent.guide", "hello");
		await until(() => app.replies.length > 0, "the agent's answer");
		const [answer] = app.replies;
		expect(answer?.channel).toBe("app:agent.guide");
		expect(answer?.reply.author).toEqual({ name: "Guide", agent: "guide" });
		// The turn ran in the room's own conversation, not in a Discord channel.
		expect(answer?.reply.chunks.join("")).toContain("echo app:agent.guide:");
		expect(answer?.reply.chunks.join("")).toContain("hello");
	});

	test("the configured coordinator is the one named, and its picture is the path the surface serves", async () => {
		const app = appSurface();
		const host = await testHost({
			discord: false,
			runtime: echo,
			config: {
				agents: [guide, { ...guide, name: "scribe", displayName: "Scribe" }],
				coordinator: "scribe",
			},
			plugins: [app.plugin],
		});
		hosts.push(host);
		const { team, avatars } = host.context.services.get(AGENTS);
		await until(() => team.coordinator() === "scribe", "the seed agents");
		expect(avatars.url(undefined)).toMatch(/^\/avatars\/[0-9a-f]{64}\.png$/);
	});

	test("fails at start, naming the missing surface, when nothing hosts the agents' rooms", async () => {
		await expect(
			testHost({
				discord: false,
				runtime: echo,
				config: { agents: [guide] },
			}),
		).rejects.toThrow(
			"agents need a surface that hosts their rooms, such as pi-roundtable-web",
		);
	});
});
