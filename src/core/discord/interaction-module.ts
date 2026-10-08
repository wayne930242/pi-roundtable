import type {
	APIApplicationCommandSubcommandGroupOption,
	APIApplicationCommandSubcommandOption,
	Interaction,
	InteractionContextType,
	RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import type { DiscordActor } from "./discord-owners.ts";

/** A group of slash commands and the components they post, handled together. */
export interface InteractionModule {
	/** Top-level commands of its own; never the configured root command. */
	commands(): RESTPostAPIChatInputApplicationCommandsJSONBody[];
	/** Resolves true when this module handled the interaction. */
	handle(interaction: Interaction): Promise<boolean>;
}

/** A subcommand or subcommand group under the root command. */
export type RootOption =
	| APIApplicationCommandSubcommandOption
	| APIApplicationCommandSubcommandGroupOption;

/** A plugin's interactions: its module, and the subcommands it adds under the root command. */
export interface InteractionContribution {
	module: InteractionModule;
	rootOptions?: readonly RootOption[];
}

/** The one root command every plugin's subcommands go under, such as `/roundtable`. */
export interface CommandRoot {
	name: string;
	description: string;
	contexts: readonly InteractionContextType[];
}

/**
 * Takes the slash commands and components of the plugins. Plugins add theirs while they set up;
 * the Discord plugin composes them in its preflight, so a clash fails before any service starts.
 */
export interface CommandRegistrar {
	/** Throws PluginError once the Discord plugin's preflight has composed the commands. */
	add(contribution: InteractionContribution): void;
}

/** Who may use the owner's commands, and how a failing command answers. */
export interface CommandGuard {
	/** The name of the root command the guard serves, without the slash. */
	readonly root: string;
	/**
	 * Text appended as it is to the refusal a non-owner gets, such as a pointer to the commands
	 * anyone may use; include the space or punctuation your language needs before it.
	 */
	readonly refusalHint?: string;
	/**
	 * Whether the actor may use the owner's commands now: an owner, the primary owner by their user
	 * id and any other by their Discord identity, checked again each time. The actor is an
	 * interaction, or anything with `user.id`, such as a test's.
	 */
	allows(actor: DiscordActor): Promise<boolean>;
	/**
	 * Whether the actor is the primary owner, by user id.
	 * @deprecated Since 0.9 every owner uses the owner's commands; ask `allows`. Goes away in 1.0.
	 */
	isOwner(actor: { user: { id: string } }): boolean;
	/** Runs a handler; a failure becomes a panel instead of a hanging interaction. */
	run(interaction: Interaction, run: () => Promise<void>): Promise<void>;
}
