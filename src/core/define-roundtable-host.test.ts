import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISCORD, type DiscordServices } from "./builtin/discord.ts";
import type { RoundtableConfig } from "./config/config.ts";
import type { ChatSurface } from "./contract/surface.ts";
import { defineRoundtable } from "./define-roundtable.ts";
import { Roundtable } from "./host.ts";
import { silentLogger } from "./log.ts";
import type { RoundtablePlugin } from "./plugin.ts";
import {
	AGENTS,
	BACKGROUND_TURNS,
	DELEGATION,
	MEMORY,
	SCHEDULES,
	SKILLS,
} from "./services.ts";
import { describeDb, testDatabaseUrl } from "./testing/database.ts";

const dataDir = mkdtempSync(join(tmpdir(), "roundtable-host-"));

const config = {
	owner: { id: "100000000000000001", name: "Ada" },
	discord: {
		token: "token",
		guild: "900000000000000001",
		entryChannel: "900000000000000002",
	},
	database: { url: testDatabaseUrl },
	dataDir,
	model: "anthropic/claude-sonnet-5-5",
	http: {
		publicUrl: "https://bot.example.com",
		socketPath: join(dataDir, "public.sock"),
	},
	agents: [
		{
			name: "librarian",
			displayName: "Librarian",
			prompt: "You keep the reading list.",
			avatarPrompt: "A calm librarian",
		},
	],
} satisfies RoundtableConfig;

/** A Discord that connects to nothing, standing in for the built-in plugin that does. */
function quietDiscord(): RoundtablePlugin {
	const surface: ChatSurface = {
		surface: "discord",
		start: async () => undefined,
		sendReply: async () => undefined,
		startTyping: () => () => undefined,
		showStop: () => () => undefined,
	};
	return {
		name: "quiet-discord",
		provides: [DISCORD],
		replaces: [DISCORD],
		setup: ({ services }) => {
			// SAFETY: the built-in plugins after it hand these to the team and the tools, which read them only when a turn or a command runs.
			services.provide(DISCORD, {
				connection: {
					agentChannels: () => ({
						post: async () => undefined,
						createChannel: async () => "900000000000000010",
						placeIn: async () => false,
						layout: async () => [],
						arrange: async () => undefined,
						setTopic: async () => undefined,
						removeWebhook: async () => undefined,
						exists: async () => true,
						read: async () => [],
					}),
					agentDashboard: () => ({ show: async () => undefined }),
					onChannelDeleted: () => undefined,
					ownerChannel: async () => "discord:owner",
					ownerOperations: () => ({}),
				},
				commands: { add: () => undefined },
				threads: { open: async () => undefined, sweep: async () => undefined },
				guard: {},
			} as unknown as DiscordServices);
			return { surfaces: [surface] };
		},
	};
}

/** A runtime that answers nothing, so the agent server builds no Pi session. */
const quietRuntime: RoundtablePlugin = {
	name: "quiet-runtime",
	providers: {
		runtime: () => ({
			runTurn: async () => ({ ok: true, text: "" }),
			steer: async () => false,
			stop: () => false,
			startFresh: async () => undefined,
			deleteConversation: async () => undefined,
			pendingConfirmation: () => undefined,
			heldActions: async () => undefined,
			recentTranscript: async () => [],
		}),
	},
	setup: () => ({}),
};

let roundtable: Roundtable | undefined;
afterEach(async () => {
	await roundtable?.shutdown("test");
	roundtable = undefined;
});

/** The default delegation worker reads pi-web-access, which a checkout has and the exported package does not list. */
function hasWebAccess(): boolean {
	try {
		import.meta.resolve("pi-web-access/package.json");
		return true;
	} catch {
		return false;
	}
}

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set and the delegation worker can load.
(hasWebAccess() ? describeDb : describe.skip)(
	"a host built by defineRoundtable",
	() => {
		test("boots over PostgreSQL with the built-in plugins, Discord replaced, and every service reads through its key", async () => {
			const seen: Record<string, unknown> = {};
			const probe: RoundtablePlugin = {
				name: "probe",
				setup: async ({ services }) => {
					const schedules = services.get(SCHEDULES);
					const agents = services.get(AGENTS);
					seen.schedules = await schedules.all();
					seen.memory = await services.get(MEMORY).forSpeaker("1").list();
					seen.agents = agents.directory.agents();
					seen.skills = services
						.get(SKILLS)
						.catalog()
						.map((skill) => skill.name);
					seen.background = typeof services.get(BACKGROUND_TURNS).runScheduled;
					seen.delegation = services.get(DELEGATION).runningChannels();
					seen.team = agents.team.guildId;
					return { services: [{ name: "probe" }] };
				},
			};
			const { options, plugins } = await defineRoundtable(
				{ ...config, plugins: [quietDiscord(), quietRuntime, probe] },
				{ logger: silentLogger() },
			);
			roundtable = new Roundtable(options, plugins);
			await roundtable.run();
			expect(seen).toMatchObject({
				schedules: expect.any(Array),
				memory: expect.any(Array),
				agents: expect.any(Array),
				skills: expect.arrayContaining(["writing-skills"]),
				background: "function",
				delegation: [],
				team: config.discord.guild,
			});
			expect(await roundtable.shutdown("test")).toBe(0);
		});
	},
);
