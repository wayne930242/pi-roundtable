import {
	type AutocompleteInteraction,
	type ChatInputCommandInteraction,
	type Interaction,
	InteractionContextType,
	MessageFlags,
	SlashCommandSubcommandGroupBuilder,
} from "discord.js";
import { messages } from "../i18n/index.ts";
import type { Logger } from "../log.ts";
import type {
	CommandGuard,
	CommandRoot,
	InteractionModule,
	RootOption,
} from "./interaction-module.ts";
import { ephemeralPanel, OwnerFacingError, ownerPanel } from "./owner-panel.ts";

/** The owner's single control command, such as `/roundtable`, every feature adds its subcommands to. */
export function ownerRootCommand(name: string): CommandRoot {
	return {
		name,
		description: messages().ownerRootDescription,
		contexts: [InteractionContextType.Guild, InteractionContextType.BotDM],
	};
}

/** A subcommand group as the JSON the root command carries. */
export const groupOption = (
	build: (
		group: SlashCommandSubcommandGroupBuilder,
	) => SlashCommandSubcommandGroupBuilder,
): RootOption => build(new SlashCommandSubcommandGroupBuilder()).toJSON();

/**
 * Only the owner may use the root command, checked by user ID; every answer is visible only to them,
 * and a failure becomes a panel instead of a hanging interaction.
 */
// pi-lens-ignore: large-class — two methods: the owner check and the failure panel
export class OwnerGuard implements CommandGuard {
	readonly #ownerId: string;
	readonly #logger: Logger;
	/** The name of the root command the guard serves, without the slash. */
	readonly root: string;
	readonly refusalHint: string | undefined;

	constructor(
		ownerId: string,
		logger: Logger,
		root: string,
		refusalHint?: string,
	) {
		this.#ownerId = ownerId;
		this.#logger = logger;
		this.root = root;
		this.refusalHint = refusalHint;
	}

	isOwner(actor: { user: { id: string } }): boolean {
		return actor.user.id === this.#ownerId;
	}

	/** Runs a handler; failures become a panel instead of a hanging interaction. */
	async run(interaction: Interaction, run: () => Promise<void>): Promise<void> {
		try {
			await run();
		} catch (error) {
			const owned = error instanceof OwnerFacingError;
			if (!owned) this.#logger.error({ err: error }, "owner command failed");
			if (!interaction.isRepliable()) return;
			const text = messages();
			const panel = {
				title: owned ? text.ownerFailedTitle : text.ownerErrorTitle,
				sections: [owned ? error.message : text.ownerErrorBody],
			};
			if (interaction.deferred || interaction.replied)
				await interaction.editReply(ownerPanel(panel));
			else await interaction.reply(ephemeralPanel(panel));
		}
	}
}

/** What `commandGuard` needs. */
export interface CommandGuardOptions {
	/** The one user who may use the owner's commands. */
	ownerId: string;
	/** The name of the root command the guard serves, without the slash. */
	root: string;
	/** Where a failing command is logged. */
	logger: Logger;
	/** Text appended as it is to the refusal a non-owner gets. */
	refusalHint?: string;
}

/** A guard for the owner's commands, such as the one a test hands a module; the Discord plugin makes its own. */
export function commandGuard(options: CommandGuardOptions): CommandGuard {
	return new OwnerGuard(
		options.ownerId,
		options.logger,
		options.root,
		options.refusalHint,
	);
}

/** One feature's part of the root command. */
export interface OwnerCommandHandlers {
	/** Whether a root subcommand, in its group or null at the top level, is this feature's. */
	owns(group: string | null, subcommand: string): boolean;
	autocomplete?(interaction: AutocompleteInteraction): Promise<void>;
	/** An answer that must be the interaction's first, such as a form; true when it answered. */
	open?(interaction: ChatInputCommandInteraction): Promise<boolean>;
	/** Answers a subcommand; the reply is already deferred and ephemeral. */
	command(interaction: ChatInputCommandInteraction): Promise<void>;
	/** Buttons, menus, and forms the feature posted; true when it handled one. */
	component?(interaction: Interaction): Promise<boolean>;
}

const refusal = (hint: string | undefined) =>
	ephemeralPanel({
		title: messages().ownerRefusalTitle,
		sections: [`${messages().ownerRefusalBody}${hint ?? ""}`],
	});

/** Answers a feature's root subcommands and components, for the owner only. */
export function ownerCommandModule(
	guard: CommandGuard,
	handlers: OwnerCommandHandlers,
): InteractionModule {
	const owned = (
		interaction: AutocompleteInteraction | ChatInputCommandInteraction,
	) =>
		interaction.commandName === guard.root &&
		handlers.owns(
			interaction.options.getSubcommandGroup(),
			interaction.options.getSubcommand(false) ?? "",
		);
	return {
		commands: () => [],
		async handle(interaction) {
			if (interaction.isAutocomplete()) {
				if (!owned(interaction)) return false;
				if (!guard.isOwner(interaction)) await interaction.respond([]);
				else await handlers.autocomplete?.(interaction);
				return true;
			}
			if (await handlers.component?.(interaction)) return true;
			if (!interaction.isChatInputCommand() || !owned(interaction))
				return false;
			if (!guard.isOwner(interaction)) {
				await interaction.reply(refusal(guard.refusalHint));
				return true;
			}
			if (await handlers.open?.(interaction)) return true;
			await interaction.deferReply({ flags: MessageFlags.Ephemeral });
			await guard.run(interaction, () => handlers.command(interaction));
			return true;
		},
	};
}
