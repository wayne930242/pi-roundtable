import {
	ActionRowBuilder,
	AttachmentBuilder,
	ButtonBuilder,
	type ButtonInteraction,
	ButtonStyle,
	ContainerBuilder,
	FileBuilder,
	LabelBuilder,
	MediaGalleryBuilder,
	MediaGalleryItemBuilder,
	MessageFlags,
	ModalBuilder,
	type ModalSubmitInteraction,
	SeparatorBuilder,
	SeparatorSpacingSize,
	StringSelectMenuBuilder,
	type StringSelectMenuInteraction,
	StringSelectMenuOptionBuilder,
	TextDisplayBuilder,
	TextInputBuilder,
	TextInputStyle,
} from "discord.js";
import {
	CATALOG,
	type CharacterInput,
	CLASS_IDS,
	type PaletteName,
} from "../../characters/index.ts";
import { characterOf } from "../agents/agent-rules.ts";
import { type Agent, MAX_PROMPT_CHARS } from "../agents/agent-store.ts";
import { AgentError } from "../domain/errors.ts";
import { messages } from "../i18n/index.ts";
import { THINKING_LEVELS, thinkingLabel } from "../models.ts";
import {
	BUILTIN_SKILLS,
	type SkillSet,
} from "../modules/skills/skill-registry.ts";
import type {
	AgentDirectory,
	AgentTeam,
	AvatarStudio,
	SkillRegistry,
} from "../services.ts";
import { OwnerFacingError, ownerPanel } from "./owner-panel.ts";

/** The custom-id prefixes of the panel's buttons and forms; posted panels carry them, so they never change. */
export const AGENT_BUTTON_PREFIX = "roundtable:agent:";
export const AGENT_MODAL_PREFIX = "roundtable:agent-modal:";
/** A prompt this long goes out as a file, so the panel stays inside Discord's text limit. */
const INLINE_PROMPT_CHARS = 2_500;

/** The models the model form offers, in this order; agent_update still sets any usable model. */
const FORM_MODELS = [
	"openai-codex/gpt-6-astra",
	"openai-codex/gpt-6-sol",
	"openai-codex/gpt-6-luna",
	"claude-bridge/claude-sonnet-5-5",
	"claude-bridge/claude-opus-5-5",
];
const DEFAULT_SETTING = "default";

/** The form's models the host can run, after the agent's current one when it is not among them. */
export function formModels(
	usable: readonly string[],
	current?: string,
): string[] {
	const offered = FORM_MODELS.filter((m) => usable.includes(m));
	return current && !offered.includes(current)
		? [current, ...offered]
		: offered;
}

type Action = "edit" | "model";
/** The buttons of the panel; the look is chosen with the two selects, `class` and `color`. */
const ACTIONS: readonly Action[] = ["edit", "model"];
type LookAction = "class" | "color";

export interface AgentCommandsOptions {
	store: Pick<AgentDirectory, "agentByChannel" | "groupByChannel" | "agent">;
	team: Pick<
		AgentTeam,
		"dress" | "update" | "modelOf" | "usableModels" | "defaultModel"
	>;
	studio: Pick<AvatarStudio, "url">;
	/** The skills an agent carries; without the skills addon the panel lists none. */
	skills?: Pick<SkillRegistry, "carried">;
}

/** An agent's panel as a message: one Components V2 container, with the prompt attached as a file when it is long. */
export interface AgentPanelMessage {
	components: ContainerBuilder[];
	flags: MessageFlags.IsComponentsV2;
	allowedMentions: { parse: never[] };
	files: AttachmentBuilder[];
}

/** The skills line of the panel: built-in ones marked, missing ones with their reason. */
export function skillsText({ skills, missing }: SkillSet): string {
	const text = messages();
	const names = skills.map((skill) =>
		(BUILTIN_SKILLS as readonly string[]).includes(skill.name)
			? text.agentSkillBuiltin(skill.name)
			: `\`${skill.name}\``,
	);
	return [
		text.agentSkills(names),
		...missing.map(({ name, reason }) => text.agentSkillMissing(name, reason)),
	].join("\n");
}

/** `/<root> profile`: an agent's prompt, avatar, model, and skills, with buttons and forms to change them. */
export class AgentCommands {
	readonly #options: AgentCommandsOptions;

	constructor(options: AgentCommandsOptions) {
		this.#options = options;
	}

	/** The panel for the agent of a channel; an error when the channel has none. */
	panel(channelId: string, note?: string): AgentPanelMessage {
		const { store } = this.#options;
		const agent = store.agentByChannel(channelId);
		if (!agent)
			throw new OwnerFacingError(
				store.groupByChannel(channelId)
					? messages().agentGroupChannel
					: messages().agentNoAgent,
			);
		return this.#panel(agent, note);
	}

	#panel(agent: Agent, note?: string): AgentPanelMessage {
		const text = messages();
		const look = characterOf(agent);
		const inline = agent.prompt.length <= INLINE_PROMPT_CHARS;
		const { model, thinking } = this.#options.team.modelOf(agent.name);
		const follows =
			agent.model === undefined && agent.thinking === undefined
				? text.agentFollowsAssistant
				: "";
		const container = new ContainerBuilder()
			.addTextDisplayComponents(
				new TextDisplayBuilder().setContent(
					text.agentHeader({
						displayName: agent.displayName,
						name: agent.name,
						model,
						thinking: thinkingLabel(thinking),
						follows,
						skills: skillsText(
							this.#options.skills?.carried(agent.name) ?? {
								skills: [],
								missing: [],
							},
						),
					}),
				),
			)
			.addMediaGalleryComponents(
				new MediaGalleryBuilder().addItems(
					new MediaGalleryItemBuilder().setURL(
						this.#options.studio.url(agent.avatarHash),
					),
				),
			)
			.addTextDisplayComponents(
				new TextDisplayBuilder().setContent(
					text.agentLook(
						CATALOG.classes[look.class].label,
						look.palette ?? look.colors.primary,
					),
				),
				new TextDisplayBuilder().setContent(
					inline
						? text.agentPromptInline(agent.prompt.replaceAll("```", "'''"))
						: text.agentPromptFile(agent.prompt.length),
				),
			);
		if (!inline)
			container.addFileComponents(
				new FileBuilder().setURL("attachment://prompt.md"),
			);
		const button = (
			action: Action,
			label: string,
			style = ButtonStyle.Secondary,
		) =>
			new ButtonBuilder()
				.setCustomId(`${AGENT_BUTTON_PREFIX}${action}:${agent.name}`)
				.setLabel(label)
				.setStyle(style);
		container
			.addSeparatorComponents(
				new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
			)
			.addActionRowComponents(
				new ActionRowBuilder<StringSelectMenuBuilder>()
					.addComponents(this.#lookMenu("class", agent.name, look.class))
					.toJSON(),
				new ActionRowBuilder<StringSelectMenuBuilder>()
					.addComponents(this.#lookMenu("color", agent.name, look.palette))
					.toJSON(),
				new ActionRowBuilder<ButtonBuilder>().addComponents(
					button("edit", text.agentEditPromptLabel, ButtonStyle.Primary),
					button("model", text.agentModelLabel),
				),
			)
			.addTextDisplayComponents(
				new TextDisplayBuilder().setContent(
					`-# ${note ?? text.agentDefaultNote}`,
				),
			);
		return {
			components: [container],
			flags: MessageFlags.IsComponentsV2 as const,
			allowedMentions: { parse: [] },
			files: inline
				? []
				: [
						new AttachmentBuilder(Buffer.from(agent.prompt), {
							name: "prompt.md",
						}),
					],
		};
	}

	/** A dropdown of the look: the 24 classes or the 8 colors, the agent's own chosen. */
	#lookMenu(
		action: LookAction,
		name: string,
		current: string | undefined,
	): StringSelectMenuBuilder {
		const text = messages();
		const option = (label: string, value: string, description?: string) => {
			const built = new StringSelectMenuOptionBuilder()
				.setLabel(label)
				.setValue(value)
				.setDefault(value === current);
			return description
				? built.setDescription(description.slice(0, 100))
				: built;
		};
		return new StringSelectMenuBuilder()
			.setCustomId(`${AGENT_BUTTON_PREFIX}${action}:${name}`)
			.setPlaceholder(
				action === "class"
					? text.agentClassPlaceholder
					: text.agentColorPlaceholder,
			)
			.addOptions(
				action === "class"
					? CLASS_IDS.map((id) =>
							option(CATALOG.classes[id].label, id, CATALOG.classes[id].jobs),
						)
					: (Object.keys(CATALOG.palettes) as PaletteName[]).map((id) =>
							option(id.charAt(0).toUpperCase() + id.slice(1), id),
						),
			);
	}

	/** A panel button: a form opens. */
	async button(interaction: ButtonInteraction): Promise<void> {
		const [action, name] = interaction.customId
			.slice(AGENT_BUTTON_PREFIX.length)
			.split(":");
		const agent = name ? this.#options.store.agent(name) : undefined;
		if (!agent) throw new OwnerFacingError(messages().agentNotFound);
		// A panel posted before 0.23 still carries the redraw buttons.
		if (!ACTIONS.includes(action as Action))
			throw new OwnerFacingError(messages().agentPanelOutdated);
		await interaction.showModal(
			action === "model"
				? await this.#modelModal(agent)
				: this.#editModal(agent),
		);
	}

	/** Two dropdowns: the model and the thinking level, each with "follow the assistant" first. */
	async #modelModal(agent: Agent): Promise<ModalBuilder> {
		const { team } = this.#options;
		const fallback = team.defaultModel();
		const models = formModels(await team.usableModels(), agent.model);
		const option = (label: string, value: string, chosen: boolean) =>
			new StringSelectMenuOptionBuilder()
				.setLabel(label.slice(0, 100))
				.setValue(value)
				.setDefault(chosen);
		const modelMenu = new StringSelectMenuBuilder()
			.setCustomId("model")
			.addOptions(
				option(
					messages().agentFollowAssistant(fallback.model),
					DEFAULT_SETTING,
					agent.model === undefined,
				),
				...models.map((m) => option(m, m, m === agent.model)),
			);
		const thinkingMenu = new StringSelectMenuBuilder()
			.setCustomId("thinking")
			.addOptions(
				option(
					messages().agentFollowAssistant(thinkingLabel(fallback.thinking)),
					DEFAULT_SETTING,
					agent.thinking === undefined,
				),
				...THINKING_LEVELS.map((level) =>
					option(level, level, level === agent.thinking),
				),
			);
		return new ModalBuilder()
			.setCustomId(`${AGENT_MODAL_PREFIX}model:${agent.name}`)
			.setTitle(messages().agentModelModalTitle(agent.displayName).slice(0, 45))
			.addLabelComponents(
				new LabelBuilder()
					.setLabel(messages().agentModelLabel)
					.setStringSelectMenuComponent(modelMenu),
				new LabelBuilder()
					.setLabel("Thinking")
					.setStringSelectMenuComponent(thinkingMenu),
			);
	}

	#editModal(agent: Agent): ModalBuilder {
		const field = (
			id: string,
			label: string,
			style: TextInputStyle,
			max: number,
			value?: string,
		) => {
			const input = new TextInputBuilder()
				.setCustomId(id)
				.setStyle(style)
				.setRequired(true)
				.setMaxLength(max);
			if (value) input.setValue(value);
			return new LabelBuilder().setLabel(label).setTextInputComponent(input);
		};
		return new ModalBuilder()
			.setCustomId(`${AGENT_MODAL_PREFIX}edit:${agent.name}`)
			.setTitle(messages().agentEditModalTitle(agent.displayName).slice(0, 45))
			.addLabelComponents(
				field(
					"display",
					messages().agentDisplayNameLabel,
					TextInputStyle.Short,
					32,
					agent.displayName,
				),
				field(
					"prompt",
					messages().agentPromptLabel,
					TextInputStyle.Paragraph,
					MAX_PROMPT_CHARS,
					agent.prompt,
				),
			);
	}

	/** A submitted form; the reply is deferred by the caller. */
	async submit(interaction: ModalSubmitInteraction): Promise<void> {
		const [action, name] = interaction.customId
			.slice(AGENT_MODAL_PREFIX.length)
			.split(":");
		const agent = name ? this.#options.store.agent(name) : undefined;
		if (!agent) throw new OwnerFacingError(messages().agentNotFound);
		const value = (id: string) => interaction.fields.getTextInputValue(id);
		const chosen = (id: string) =>
			interaction.fields.getStringSelectValues(id)[0] ?? DEFAULT_SETTING;
		if (action === "edit" || action === "model") {
			try {
				await this.#options.team.update(
					agent.name,
					action === "edit"
						? { displayName: value("display"), prompt: value("prompt") }
						: { model: chosen("model"), thinking: chosen("thinking") },
				);
			} catch (error) {
				if (error instanceof AgentError)
					throw new OwnerFacingError(error.message);
				throw error;
			}
			const updated = this.#options.store.agent(agent.name) ?? agent;
			await interaction.editReply(this.#panel(updated, messages().agentSaved));
			return;
		}
		throw new OwnerFacingError(messages().agentPanelOutdated);
	}

	/**
	 * A choice in one of the panel's two dropdowns, class or color; the reply is deferred by the
	 * caller. The choice goes through `dress`, which keeps the colors on a new class and the
	 * class on a new color.
	 */
	async select(interaction: StringSelectMenuInteraction): Promise<void> {
		const [action, name] = interaction.customId
			.slice(AGENT_BUTTON_PREFIX.length)
			.split(":");
		const chosen = interaction.values[0];
		if (
			!name ||
			chosen === undefined ||
			(action !== "class" && action !== "color")
		)
			throw new OwnerFacingError(messages().agentNotFound);
		const input: CharacterInput =
			action === "class"
				? { class: chosen as CharacterInput["class"] }
				: { palette: chosen as PaletteName };
		await interaction.editReply(await this.#dress(name, input));
	}

	async #dress(name: string, input: CharacterInput) {
		try {
			const agent = await this.#options.team.dress(name, input);
			return this.#panel(agent, messages().agentLookChanged);
		} catch (error) {
			if (!(error instanceof AgentError)) throw error;
			const agent = this.#options.store.agent(name);
			return agent
				? this.#panel(
						agent,
						messages().agentLookFailed(error.message).slice(0, 300),
					)
				: ownerPanel({
						title: messages().ownerFailedTitle,
						sections: [error.message],
					});
		}
	}
}
