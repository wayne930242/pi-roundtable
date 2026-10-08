import {
	type AutocompleteInteraction,
	type ChatInputCommandInteraction,
	type Interaction,
	InteractionContextType,
	MessageFlags,
	SlashCommandSubcommandGroupBuilder,
} from "discord.js";
import { messages } from "../i18n/index.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type { Logger } from "../log.ts";
import {
	type DiscordActor,
	DiscordOwners,
	discordUser,
} from "./discord-owners.ts";
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
 * Only an owner may use the root command: the primary owner by user ID, and, with the identity
 * service, every other owner principal's Discord identity, checked again each time. Every answer
 * is visible only to them, and a failure becomes a panel instead of a hanging interaction.
 */
// pi-lens-ignore: large-class — three methods: the owner checks and the failure panel
export class OwnerGuard implements CommandGuard {
	readonly #owners: DiscordOwners;
	readonly #logger: Logger;
	/** The name of the root command the guard serves, without the slash. */
	readonly root: string;
	readonly refusalHint: string | undefined;

	constructor(
		owners: DiscordOwners,
		logger: Logger,
		root: string,
		refusalHint?: string,
	) {
		this.#owners = owners;
		this.#logger = logger;
		this.root = root;
		this.refusalHint = refusalHint;
	}

	allows(actor: DiscordActor): Promise<boolean> {
		return this.#owners.isOwner(discordUser(actor));
	}

	isOwner(actor: { user: { id: string } }): boolean {
		return actor.user.id === this.#owners.primary;
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
	/** The primary owner's Discord user id, who may always use the owner's commands. */
	ownerId: string;
	/** Which other owners there are and whether they still are; without it only `ownerId` may. */
	identity?: Pick<IdentityService, "resolve" | "owners" | "identities">;
	/** The name of the root command the guard serves, without the slash. */
	root: string;
	/** Where a failing command is logged. */
	logger: Logger;
	/** Text appended as it is to the refusal a non-owner gets. */
	refusalHint?: string;
}

/** A guard for the owner's commands, such as the one a test hands a module; the Discord plugin makes its own. */
export function commandGuard(options: CommandGuardOptions): CommandGuard {
	const { ownerId, identity, logger } = options;
	return new OwnerGuard(
		new DiscordOwners({ ownerId, ...(identity ? { identity } : {}), logger }),
		logger,
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

/** Answers a feature's root subcommands and components, for the owners only. */
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
				if (!(await guard.allows(interaction))) await interaction.respond([]);
				else await handlers.autocomplete?.(interaction);
				return true;
			}
			if (await handlers.component?.(interaction)) return true;
			if (!interaction.isChatInputCommand() || !owned(interaction))
				return false;
			if (!(await guard.allows(interaction))) {
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
