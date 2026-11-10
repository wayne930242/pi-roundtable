import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentServerTeam } from "./core/agents/agent-team.ts";
import type { InboundMessage } from "./core/contract/channels.ts";
import type { AgentRuntime } from "./core/contract/runtime.ts";
import type { ChatSurface } from "./core/contract/surface.ts";
import type { OutboundReply } from "./core/domain/conversation.ts";
import type { AgentTurnScope } from "./core/domain/sessions.ts";
import { defineRoundtable } from "./core/host/define-roundtable.ts";
import { Roundtable } from "./core/host/host.ts";
import { silentLogger } from "./core/kernel/log.ts";
import type { RoundtablePlugin } from "./core/plugin-api/plugin.ts";
import { AGENTS } from "./core/plugin-api/services.ts";
import { describeDb } from "./core/testing/database.ts";
import { registeredTools, toolNamed } from "./core/testing/run-tool.ts";
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

const seed = (name: string, displayName: string) => ({
	name,
	displayName,
	prompt: `You are ${displayName}.`,
	avatarPrompt: displayName,
});
const agents = [seed("guide", "Guide"), seed("scribe", "Scribe")];

/** A chat surface `app` that hosts agent rooms, as pi-roundtable-web does; `say` posts as its owner. */
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
	const say = (channel: string, text: string) =>
		deliver?.({
			channel: channel as InboundMessage["channel"],
			messageId: "m1",
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

const scope = (name: string): AgentTurnScope => ({
	name,
	session: `app:agent.${name}` as AgentTurnScope["session"],
	home: `app:agent.${name}` as AgentTurnScope["home"],
});

test("Roundtable.check() passes for Discord without an agent guild", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "roundtable-app-team-"));
	const defined = await defineRoundtable(
		{
			owner: { id: "100000000000000001", name: "Ada" },
			discord: { token: "token" },
			agents,
			coordinator: "scribe",
			database: { url: "postgres://unused@127.0.0.1:1/none" },
			dataDir,
			model: "anthropic/claude-sonnet-5-5",
			plugins: [appSurface().plugin],
		},
		{ logger: silentLogger() },
	);
	const report = await new Roundtable(defined.options, defined.plugins).check();
	expect(report.plugins).toContain("discord");
	expect(report.plugins).toContain("agent-server");
});

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb(
	"an agent team in the app on a host whose Discord has no agent guild",
	() => {
		test("boots, keeps the plugins' commands, never asks Discord for the agents' channels, and runs the team in rooms", async () => {
			const asked: string[] = [];
			const app = appSurface();
			const host = await testHost({
				runtime: echo,
				discord: {
					agentChannels: (guildId) => {
						asked.push(`channels ${guildId}`);
						return {} as never;
					},
				},
				config: {
					discord: { token: "token" },
					agents,
					coordinator: "scribe",
				},
				plugins: [app.plugin],
			});
			hosts.push(host);
			const { team } = host.context.services.get(AGENTS);
			await until(() => team.coordinator() === "scribe", "the seed agents");
			expect(team.guildId).toBe("local");
			expect(team.roomsOf("guide")).toEqual(["app:agent.guide"]);
			// The root command and its schedule subcommand are still composed for the other guilds.
			expect(
				host.commands.composed().commands.map((command) => command.name),
			).toContain("roundtable");

			const tools = await registeredTools(
				(team as unknown as AgentServerTeam).extension(scope("scribe")),
			);
			const names = tools.map((tool) => tool.name);
			expect(names).toContain("agent_list");
			expect(names).toContain("helper_create");
			expect(names).not.toContain("channel_arrange");
			expect(names).not.toContain("channel_read");
			const list = await toolNamed(tools, "agent_list").execute("1", {});
			const listed = list.content.map((part) => part.text ?? "").join("");
			expect(listed).toContain("guide");
			expect(listed).not.toContain("Categories, in server order");

			app.say("app:agent.guide", "hello");
			await until(() => app.replies.length > 0, "the agent's answer");
			expect(app.replies[0]?.channel).toBe("app:agent.guide");
			expect(app.replies[0]?.reply.chunks.join("")).toContain(
				"echo app:agent.guide:",
			);
			expect(asked).toEqual([]);
		});
	},
);
