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
	StringSelectMenuOptionBuilder,
	TextDisplayBuilder,
	TextInputBuilder,
	TextInputStyle,
} from "discord.js";
import {
	type Agent,
	type AgentStore,
	MAX_AVATAR_PROMPT_CHARS,
	MAX_PROMPT_CHARS,
} from "../agents/agent-store.ts";
import type { AgentTeam } from "../agents/agent-team.ts";
import type { AvatarMode } from "../agents/agent-tools.ts";
import type { AvatarStudio } from "../agents/avatar-studio.ts";
import { AgentError } from "../domain/errors.ts";
import { messages } from "../i18n/index.ts";
import { THINKING_LEVELS, thinkingLabel } from "../models.ts";
import {
	BUILTIN_SKILLS,
	type SkillRegistry,
	type SkillSet,
} from "../modules/skills/skill-registry.ts";
import { OwnerFacingError, ownerPanel } from "./owner-panel.ts";

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

type Action = "edit" | "redraw" | "newprompt" | "editavatar" | "model";
const ACTIONS: readonly Action[] = [
	"edit",
	"redraw",
	"newprompt",
	"editavatar",
	"model",
];

export interface AgentCommandsOptions {
	store: Pick<AgentStore, "agentByChannel" | "groupByChannel" | "agent">;
	team: Pick<
		AgentTeam,
		"redrawAvatar" | "update" | "modelOf" | "usableModels" | "defaultModel"
	>;
	studio: Pick<AvatarStudio, "url">;
	skills: Pick<SkillRegistry, "carried">;
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
	panel(channelId: string, note?: string) {
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

	#panel(agent: Agent, note?: string) {
		const text = messages();
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
						skills: skillsText(this.#options.skills.carried(agent.name)),
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
					text.agentAvatarPromptText(agent.avatarPrompt),
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
				new ActionRowBuilder<ButtonBuilder>().addComponents(
					button("edit", text.agentEditPromptLabel, ButtonStyle.Primary),
					button("redraw", text.agentRedrawLabel),
					button("newprompt", text.agentNewAvatarPromptLabel),
					button("editavatar", text.agentEditAvatarLabel),
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

	/** A panel button: a form opens, or a redraw starts. */
	async button(interaction: ButtonInteraction): Promise<void> {
		const [action, name] = interaction.customId
			.slice(AGENT_BUTTON_PREFIX.length)
			.split(":");
		const agent = name ? this.#options.store.agent(name) : undefined;
		if (!agent || !ACTIONS.includes(action as Action))
			throw new OwnerFacingError(messages().agentNotFound);
		if (action === "redraw") {
			await interaction.deferReply({ flags: MessageFlags.Ephemeral });
			await interaction.editReply(await this.#avatar(agent.name, "redraw"));
			return;
		}
		await interaction.showModal(
			action === "model"
				? await this.#modelModal(agent)
				: this.#modal(action as Action, agent),
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

	#modal(action: Action, agent: Agent): ModalBuilder {
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
		const modal = new ModalBuilder().setCustomId(
			`${AGENT_MODAL_PREFIX}${action}:${agent.name}`,
		);
		if (action === "edit")
			return modal
				.setTitle(
					messages().agentEditModalTitle(agent.displayName).slice(0, 45),
				)
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
		if (action === "newprompt")
			return modal
				.setTitle(messages().agentNewAvatarPromptLabel)
				.addLabelComponents(
					field(
						"text",
						messages().agentAvatarPromptLabel,
						TextInputStyle.Paragraph,
						MAX_AVATAR_PROMPT_CHARS,
						agent.avatarPrompt,
					),
				);
		return modal
			.setTitle(messages().agentEditAvatarLabel)
			.addLabelComponents(
				field(
					"text",
					messages().agentEditAvatarField,
					TextInputStyle.Paragraph,
					MAX_AVATAR_PROMPT_CHARS,
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
		const mode: AvatarMode = action === "newprompt" ? "new_prompt" : "edit";
		await interaction.editReply(
			await this.#avatar(agent.name, mode, value("text")),
		);
	}

	async #avatar(name: string, mode: AvatarMode, text?: string) {
		try {
			const agent = await this.#options.team.redrawAvatar(name, mode, text);
			return this.#panel(agent, messages().agentAvatarRedrawn);
		} catch (error) {
			if (!(error instanceof AgentError)) throw error;
			const agent = this.#options.store.agent(name);
			return agent
				? this.#panel(
						agent,
						messages().agentAvatarFailed(error.message).slice(0, 300),
					)
				: ownerPanel({
						title: messages().ownerFailedTitle,
						sections: [error.message],
					});
		}
	}
}
