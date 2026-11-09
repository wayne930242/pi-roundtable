import { DISCORD, type DiscordServices } from "../builtin/discord.ts";
import { CommandCollection } from "../discord/command-collection.ts";
import type { ComposedCommands } from "../discord/compose-commands.ts";
import type {
	CommandGuard,
	CommandRegistrar,
	InteractionContribution,
} from "../discord/interaction-module.ts";
import { commandGuard, ownerRootCommand } from "../discord/owner-command.ts";
import type { DiscordPoster } from "../discord/poster/poster.ts";
import { silentLogger } from "../kernel/log.ts";
import { fakeDiscordPoster } from "./fake-poster.ts";
import { type ServicePair, servicePair } from "./service-pair.ts";

/** A stand-in for the Discord plugin's `DISCORD` service, made by `fakeDiscord()`. */
export interface FakeDiscord {
	/** Give this to `testPlugin`'s `services` option: `{ services: [discord.service] }`. */
	readonly service: ServicePair;
	/** What `DISCORD.commands` is to the plugin: the real registrar, which refuses what the Discord plugin refuses. */
	readonly commands: CommandRegistrar;
	/** What `DISCORD.poster` is: the one the test gave, else a `fakeDiscordPoster()`. */
	readonly poster: DiscordPoster;
	/** What `DISCORD.guard` is: the owner, `owner` unless the test gave another id, serving the root command. */
	readonly guard: CommandGuard;
	/** Every contribution the plugin added, in the order it added them. */
	added(): readonly InteractionContribution[];
	/** The tree the Discord plugin would register, composed under the root command the fake was made with. */
	compose(): ComposedCommands;
}

/**
 * A `DISCORD` service for a plugin that adds slash commands, without a Discord connection: the
 * plugin's `commands.add` calls are recorded, and `compose()` shows the tree Discord would get.
 * `rootCommand` is the root command's name, `roundtable` by default. `channelContext` is what
 * `DISCORD.channelContext` answers, by default no context, as on a host with it off. Only
 * `commands`, `guard`, `poster`, and `channelContext` are given; reading another member throws.
 */
export function fakeDiscord(
	options: {
		ownerId?: string;
		rootCommand?: string;
		channelContext?: DiscordServices["channelContext"];
		poster?: DiscordPoster;
	} = {},
): FakeDiscord {
	const collection = new CommandCollection();
	const { rootCommand = "roundtable" } = options;
	const guard = commandGuard({
		ownerId: options.ownerId ?? "owner",
		root: rootCommand,
		logger: silentLogger(),
	});
	const poster = options.poster ?? fakeDiscordPoster();
	return {
		service: servicePair(DISCORD, {
			commands: collection.registrar,
			guard,
			poster,
			channelContext: options.channelContext ?? (async () => undefined),
		}),
		poster,
		commands: collection.registrar,
		guard,
		added: () => collection.added(),
		compose: () => collection.compose(ownerRootCommand(rootCommand)),
	};
}
