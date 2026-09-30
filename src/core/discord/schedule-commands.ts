import type {
	AutocompleteInteraction,
	ChatInputCommandInteraction,
	SlashCommandSubcommandGroupBuilder,
} from "discord.js";
import type { InteractionContribution } from "../contract/discord.ts";
import { messages } from "../i18n/index.ts";
import { describeRecurrence } from "../modules/schedules/recurrence.ts";
import type {
	Schedule,
	ScheduleStore,
} from "../modules/schedules/schedule-store.ts";
import {
	groupOption,
	type OwnerGuard,
	ownerCommandModule,
} from "./owner-command.ts";
import {
	OwnerFacingError,
	ownerPanel,
	plain,
	replyWithPanels,
} from "./owner-panel.ts";

const PROMPT_PREVIEW = 160;

function scheduleGroup(group: SlashCommandSubcommandGroupBuilder) {
	return group
		.setName("schedule")
		.setDescription(messages().scheduleGroupDescription)
		.addSubcommand((sub) =>
			sub.setName("list").setDescription(messages().scheduleListDescription),
		)
		.addSubcommand((sub) =>
			sub
				.setName("cancel")
				.setDescription(messages().scheduleCancelDescription)
				.addStringOption((option) =>
					option
						.setName("id")
						.setDescription(messages().scheduleIdDescription)
						.setRequired(true)
						.setAutocomplete(true),
				),
		);
}

function channelMention(schedule: Schedule): string {
	const [surface, id] = schedule.channel.split(":");
	return surface === "discord" && id ? `<#${id}>` : plain(schedule.channel);
}

const unix = (at: Date) => Math.floor(at.getTime() / 1000);

function section(schedule: Schedule): string {
	const prompt =
		schedule.prompt.length > PROMPT_PREVIEW
			? `${schedule.prompt.slice(0, PROMPT_PREVIEW)}…`
			: schedule.prompt;
	const text = messages();
	const last = schedule.lastRun
		? text.scheduleLastRun(
				unix(schedule.lastRun),
				plain(schedule.lastStatus ?? "?"),
			)
		: "";
	const mode =
		schedule.mode === "owner" ? text.scheduleModeOwner : text.scheduleModeParty;
	return [
		text.scheduleHead(
			schedule.id,
			plain(schedule.title),
			channelMention(schedule),
			mode,
		),
		text.scheduleNextRun(
			describeRecurrence(schedule.recurrence),
			unix(schedule.nextRun),
		),
		text.scheduleSetBy(plain(schedule.createdByName), last),
		`-# ${plain(prompt)}`,
	].join("\n");
}

/** `/<root> schedule`: the owner's view over every channel's schedules. */
export class ScheduleCommands {
	readonly #store: ScheduleStore;

	constructor(store: ScheduleStore) {
		this.#store = store;
	}

	async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
		const query = interaction.options.getFocused().trim().toLocaleLowerCase();
		const choices = (await this.#store.all())
			.map((s) => ({
				name: messages()
					.scheduleChoice(s.id, s.title, describeRecurrence(s.recurrence))
					.slice(0, 100),
				value: String(s.id),
			}))
			.filter((choice) => choice.name.toLocaleLowerCase().includes(query));
		await interaction.respond(choices.slice(0, 25));
	}

	/** The interaction is deferred and ephemeral. */
	async command(interaction: ChatInputCommandInteraction): Promise<void> {
		if (interaction.options.getSubcommand(true) === "cancel")
			return this.#cancel(interaction);
		const all = await this.#store.all();
		await replyWithPanels(interaction, {
			title: messages().scheduleTitle,
			sections: all.length ? all.map(section) : [messages().scheduleNone],
			footer: messages().scheduleFooter,
		});
	}

	async #cancel(interaction: ChatInputCommandInteraction): Promise<void> {
		const raw = interaction.options.getString("id", true).replace(/^#/, "");
		const id = Number(raw);
		if (!Number.isInteger(id))
			throw new OwnerFacingError(messages().schedulePickOne);
		const removed = await this.#store.remove(id);
		if (!removed)
			throw new OwnerFacingError(messages().scheduleUnknown(plain(raw)));
		await interaction.editReply(
			ownerPanel({
				title: messages().scheduleCancelled,
				sections: [section(removed)],
			}),
		);
	}
}

/** `/<root> schedule list|cancel`. */
export function scheduleCommands(
	guard: OwnerGuard,
	store: ScheduleStore,
): InteractionContribution {
	const commands = new ScheduleCommands(store);
	return {
		module: ownerCommandModule(guard, {
			owns: (group) => group === "schedule",
			autocomplete: (interaction) => commands.autocomplete(interaction),
			command: (interaction) => commands.command(interaction),
		}),
		rootOptions: [groupOption(scheduleGroup)],
	};
}
