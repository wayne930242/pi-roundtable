import { join } from "node:path";
import { AvatarStudio } from "../agents/avatar-studio.ts";
import { DiscordSurface } from "../discord/discord-surface.ts";
import { DispatchThreads } from "../discord/dispatch-threads.ts";
import { OwnerCards } from "../discord/owner-cards.ts";
import { OwnerGuard } from "../discord/owner-command.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import type { SpeakerPolicy } from "../speakers.ts";

export interface DiscordOptions {
	token: string;
	ownerId: string;
	/** How the owner is named in audit-log reasons and refusals. */
	ownerName: string;
	/** Who may answer a card besides the owner. */
	speakers: SpeakerPolicy;
	dataDir: string;
	/** The origin the agents' pictures are served from. */
	avatarUrl: string;
	/** The name of the root slash command, without the slash. */
	rootCommand: string;
	/** The assistant's neutral avatar: the style reference and the picture of an agent without one. */
	avatarReference: string;
}

/**
 * The Discord connection and what stands on it: the avatar studio, the owner's cards, the owner
 * guard, and the threads that carry background reports. It starts the surface, and the channel
 * queue joins the shutdown drain.
 */
export function discordPlugin(options: DiscordOptions): RoundtablePlugin {
	let commands: DiscordSurface | undefined;
	return {
		name: "discord",
		// Discord registers the commands as it connects, so they go to the surface before it starts.
		useCommands: (composed) => commands?.useInteractions(composed),
		setup: async ({ queue, conversations, providers, core, logger }) => {
			const studio = new AvatarStudio({
				dir: join(options.dataDir, "avatars"),
				publicUrl: options.avatarUrl,
				referencePath: options.avatarReference,
				draw: providers.images,
			});
			await studio.init();
			// The surface exists by the time a turn posts a card.
			const cards: OwnerCards = new OwnerCards({
				ownerId: options.ownerId,
				speakers: options.speakers,
				channel: (channelId) => surface.cardChannel(channelId),
				logger,
			});
			const surface = new DiscordSurface({
				token: options.token,
				ownerId: options.ownerId,
				ownerName: options.ownerName,
				logger,
			});
			const guard = new OwnerGuard(
				options.ownerId,
				logger,
				options.rootCommand,
			);
			// A channel whose owner keeps reports in place, such as a party channel, opens no thread.
			const threads = new DispatchThreads({
				host: {
					open: (parentId, name, line) =>
						surface.threadHost().open(parentId, name, line),
					post: (threadId, text) => surface.threadHost().post(threadId, text),
					close: (threadId) => surface.threadHost().close(threadId),
				},
				ledgerPath: join(options.dataDir, "dispatch-threads.json"),
				excluded: (channel) => conversations.postsInPlace(channel),
				logger,
			});
			commands = surface;
			core.provide("discord", { surface, cards, guard, studio, threads });
			return {
				services: [
					{
						name: "surface",
						start: async () => {
							await surface.start(
								(message) => void conversations.handle(message),
							);
							void threads.sweep();
						},
						stop: () => surface.stop(),
					},
					{ name: "channel-queue", busy: () => queue.busy() },
				],
				interactions: [{ module: cards }],
			};
		},
	};
}
