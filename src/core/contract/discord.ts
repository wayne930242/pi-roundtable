import type {
	APIApplicationCommandSubcommandGroupOption,
	APIApplicationCommandSubcommandOption,
	Interaction,
	InteractionContextType,
	RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";

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
