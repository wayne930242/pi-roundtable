import { join } from "node:path";
import { type ServiceKey, serviceKey } from "../contract/services.ts";
import { CommandCollection } from "../discord/command-collection.ts";
import type { DiscordConnection } from "../discord/connection.ts";
import { DiscordSurface } from "../discord/discord-surface.ts";
import { DispatchThreads } from "../discord/dispatch-threads.ts";
import type {
	CommandGuard,
	CommandRegistrar,
} from "../discord/interaction-module.ts";
import { OwnerCards } from "../discord/owner-cards.ts";
import { OwnerGuard, ownerRootCommand } from "../discord/owner-command.ts";
import { stopButtonModule } from "../discord/stop-button.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import { IDENTITY } from "../services.ts";

/** The Discord connection and what stands on it, as plugins use it. Provided by the Discord plugin. */
export interface DiscordServices {
	connection: DiscordConnection;
	/** Adds a plugin's slash commands and components; during setup only. */
	commands: CommandRegistrar;
	/** Who may use the owner's commands. */
	guard: CommandGuard;
	/** The threads that carry background reports. */
	threads: DispatchThreads;
}

/** The Discord connection, provided by the Discord plugin. */
export const DISCORD: ServiceKey<DiscordServices> =
	serviceKey<DiscordServices>("roundtable.discord");

export interface DiscordOptions {
	token: string;
	ownerId: string;
	/** How the owner is named in audit-log reasons and refusals. */
	ownerName: string;
	dataDir: string;
	/** The name of the root slash command, without the slash. */
	rootCommand: string;
	/** Text appended as it is to the refusal a non-owner gets, such as a pointer to the commands anyone may use. */
	refusalHint?: string;
}

/**
 * The Discord connection and what stands on it: the owner's cards, the command guard, and the
 * threads that carry background reports. It contributes the Discord surface, collects the
 * plugins' slash commands while they set up, and composes them under the root command in its
 * preflight, so a clash fails before any service starts.
 */
export function discordPlugin(options: DiscordOptions): RoundtablePlugin {
	const collection = new CommandCollection();
	let surface: DiscordSurface | undefined;
	return {
		name: "discord",
		provides: [DISCORD],
		preflight: () => {
			// The host has applied its environment by now, so the description is in its language.
			surface?.setCommands(
				collection.compose(ownerRootCommand(options.rootCommand)),
			);
		},
		setup: async ({ conversations, services, logger }) => {
			const identity = services.find(IDENTITY);
			// The surface exists by the time a turn posts a card.
			const cards: OwnerCards = new OwnerCards({
				ownerId: options.ownerId,
				// Who may answer a card besides the primary owner, by the identity service.
				...(identity ? { identity } : {}),
				channel: (channelId) => connected.cardChannel(channelId),
				logger,
			});
			const connected = new DiscordSurface({
				token: options.token,
				ownerId: options.ownerId,
				ownerName: options.ownerName,
				prompts: (channel, scope) => cards.prompts(channel, scope),
				logger,
			});
			surface = connected;
			const guard = new OwnerGuard(
				options.ownerId,
				logger,
				options.rootCommand,
				options.refusalHint,
			);
			// A channel whose claim keeps reports in place, such as an open channel, opens no thread.
			const threads = new DispatchThreads({
				host: {
					open: (parentId, name, line) =>
						connected.threadHost().open(parentId, name, line),
					post: (threadId, text) => connected.threadHost().post(threadId, text),
					close: (threadId) => connected.threadHost().close(threadId),
				},
				ledgerPath: join(options.dataDir, "dispatch-threads.json"),
				excluded: (channel) => conversations.postsInPlace(channel),
				logger,
			});
			// The cards answer the interactions of held actions, and core posts the stop button, so
			// core answers both; they come first, as they always have.
			collection.registrar.add({ module: cards });
			collection.registrar.add({
				module: stopButtonModule({ guard, conversations }),
			});
			services.provide(DISCORD, {
				connection: connected,
				commands: collection.registrar,
				guard,
				threads,
			});
			return {
				// The host starts the surface first; it registers the composed commands as it connects.
				surfaces: [connected],
				services: [
					// The sweep reads threads through the connection, so it follows the surface's start.
					{ name: "threads", start: () => void threads.sweep() },
				],
			};
		},
	};
}
