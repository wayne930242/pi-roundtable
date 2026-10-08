import { randomUUID } from "node:crypto";
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type Interaction,
	LabelBuilder,
	MessageFlags,
	ModalBuilder,
	StringSelectMenuBuilder,
	TextDisplayBuilder,
	TextInputBuilder,
	TextInputStyle,
} from "discord.js";
import { parseChannelKey } from "../contract/surface.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import type {
	Approval,
	OwnerAnswer,
	OwnerPrompts,
	OwnerQuestion,
} from "../domain/owner-prompts.ts";
import { messages } from "../i18n/index.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type { Logger } from "../log.ts";
import { type Speaker, type Tier, tierAtLeast } from "../speakers.ts";
import type { InteractionModule } from "./interaction-module.ts";
import { ownerPanel, type PanelContent, plain } from "./owner-panel.ts";

export const CARD_PREFIX = "roundtable:card:";
/** An unanswered card expires after this long. */
export const CARD_TIMEOUT_MS = 30 * 60_000;
const OTHER = "other";
const TEXT_FIELD = "text";

/** A card's message: the panel, led by a mention of the owner in a thread. */
export type CardPayload = Omit<
	ReturnType<typeof ownerPanel>,
	"components" | "allowedMentions"
> & {
	components: (
		| ReturnType<typeof ownerPanel>["components"][number]
		| TextDisplayBuilder
	)[];
	allowedMentions: { parse?: never[]; users?: string[] };
};

/** The posted card, which is edited to show how it ended. */
export interface CardMessage {
	edit(payload: CardPayload): Promise<unknown>;
}

/** Where a channel's cards are posted. */
export interface CardChannel {
	send(payload: CardPayload): Promise<CardMessage>;
	/** A thread, where the owner is mentioned so they hear of the card; a channel never mentions them. */
	thread?: boolean;
}

export interface OwnerCardsOptions {
	ownerId: string;
	/** Who holds a tier now, for cards that lower tiers may answer; without it only the owner answers. */
	identity?: Pick<IdentityService, "resolve">;
	/** The Discord channel by id; throws when it cannot take messages. */
	channel(channelId: string): Promise<CardChannel>;
	logger: Logger;
	/** CARD_TIMEOUT_MS by default. */
	timeoutMs?: number;
}

type Rows = NonNullable<Parameters<typeof ownerPanel>[0]["rows"]>;

/** One open card: how it looks, and how it ends. */
interface OpenCard {
	title: string;
	sections: string[];
	/** The card's controls, disabled once it has ended. */
	rows(disabled: boolean): Rows;
	/** Ends the card with its answer; the answering interaction shows the outcome. */
	end(value: unknown): void;
	question?: OwnerQuestion;
	/** Options chosen together with "Other…", kept while its form is open. */
	picked?: string[];
	/** Posted in a thread, so it leads with the mention of who may answer. */
	mention?: boolean;
	/** Who may answer, and what to tell someone else who presses it. */
	audience: Audience;
}

/** The people a card is for. */
interface Audience {
	/** Whether this user may answer; their roles are unknown where the press carries no member. */
	allows(user: {
		id: string;
		name: string;
		roleIds?: readonly string[];
	}): boolean | Promise<boolean>;
	/** The user the card mentions in a thread. */
	mentionId: string;
	/** Shown on the card. */
	note: string;
	refusal: string;
}

/**
 * The owner's cards in the assistant's channels: approvals of held actions and ask_user questions,
 * answered with buttons, a menu, or a form. The owner may answer, and so may the speaker whose
 * turn asks, when the card allows (a question always; an approval at its tier); an unanswered card
 * expires after 30 minutes and a stopped turn cancels it. Open cards live in memory, so a
 * restart abandons them; pressing one then says it no longer works.
 */
export class OwnerCards implements InteractionModule {
	readonly #options: OwnerCardsOptions;
	readonly #open = new Map<string, OpenCard>();

	constructor(options: OwnerCardsOptions) {
		this.#options = options;
	}

	commands() {
		return [];
	}

	/** The channel's cards; the chat surface port sends only Discord keys here. */
	prompts(channel: ChannelKey, speaker?: Speaker): OwnerPrompts | undefined {
		const channelId = parseChannelKey(channel).id;
		return {
			confirm: (title, message, signal, minTier = "owner") =>
				this.#post<Approval>(channelId, signal, "expired", "cancelled", {
					audience: this.#approvers(minTier, speaker),
					title,
					sections: [message],
					rows: (id, disabled) => [
						new ActionRowBuilder<ButtonBuilder>().addComponents(
							new ButtonBuilder()
								.setCustomId(`${CARD_PREFIX}${id}:yes`)
								.setLabel(messages().cardRunLabel)
								.setEmoji("✅")
								.setStyle(ButtonStyle.Success)
								.setDisabled(disabled),
							new ButtonBuilder()
								.setCustomId(`${CARD_PREFIX}${id}:no`)
								.setLabel(messages().cardCancelLabel)
								.setEmoji("❌")
								.setStyle(ButtonStyle.Secondary)
								.setDisabled(disabled),
						),
					],
					footer: messages().cardApprovalFooter,
				}),
			ask: (title, question, signal) =>
				this.#post<OwnerAnswer | undefined>(
					channelId,
					signal,
					undefined,
					undefined,
					{
						audience: this.#asker(speaker),
						title,
						sections: [question.question],
						question,
						rows: (id, disabled) => askRows(id, question, disabled),
						footer: messages().cardQuestionFooter,
					},
				),
		};
	}

	/** Posts a card and resolves with its answer, `expired`, or `cancelled`. */
	#post<T>(
		channelId: string,
		signal: AbortSignal | undefined,
		expired: T,
		cancelled: T,
		card: {
			audience: Audience;
			title: string;
			sections: string[];
			question?: OwnerQuestion;
			rows(id: string, disabled: boolean): Rows;
			footer: string;
		},
	): Promise<T> {
		const { logger, timeoutMs = CARD_TIMEOUT_MS } = this.#options;
		if (signal?.aborted) return Promise.resolve(cancelled);
		const id = randomUUID();
		const sections = [
			...card.sections,
			...(card.audience.note ? [card.audience.note] : []),
		];
		return new Promise<T>((resolve) => {
			let message: CardMessage | undefined;
			let finish: string | undefined;
			const settle = (value: T, outcome: string | undefined) => {
				if (!this.#open.delete(id)) return;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				// A card ended by an answer is edited by the answering interaction.
				if (outcome !== undefined) {
					finish = outcome;
					void message
						?.edit(view(outcome))
						.catch((error: unknown) =>
							logger.warn({ channelId, err: error }, "card not closed"),
						);
				}
				resolve(value);
			};
			const view = (footer: string, disabled = true) =>
				this.#panel(
					{
						title: card.title,
						sections,
						rows: card.rows(id, disabled),
						footer,
					},
					open.mention === true,
					card.audience.mentionId,
				);
			const abort = () => settle(cancelled, messages().cardStopped);
			const timer = setTimeout(
				() => settle(expired, messages().cardExpired),
				timeoutMs,
			);
			signal?.addEventListener("abort", abort, { once: true });
			const open: OpenCard = {
				title: card.title,
				sections,
				rows: (disabled) => card.rows(id, disabled),
				audience: card.audience,
				end: (value) => settle(value as T, undefined),
				...(card.question ? { question: card.question } : {}),
			};
			this.#open.set(id, open);
			this.#options
				.channel(channelId)
				.then((channel) => {
					open.mention = channel.thread === true;
					return channel.send(view(card.footer, false));
				})
				.then((posted) => {
					message = posted;
					// Ended while it was being posted.
					if (finish !== undefined) void posted.edit(view(finish));
				})
				.catch((error: unknown) => {
					logger.warn({ channelId, err: error }, "card not posted");
					settle(expired, undefined);
				});
		});
	}

	/** The card's panel; in a thread it leads with the mention of who may answer. */
	#panel(content: PanelContent, mention: boolean, userId: string): CardPayload {
		const panel = ownerPanel(content);
		if (!mention) return panel;
		return {
			...panel,
			components: [
				new TextDisplayBuilder().setContent(`<@${userId}>`),
				...panel.components,
			],
			allowedMentions: { users: [userId] },
		};
	}

	/**
	 * An approval is for the speaker whose turn held the call, when their tier holds it, and for
	 * the owner; the owner's alone by default. A call only the owner tier may make is so for
	 * another owner's turn too, such as one the CLI granted. Nobody else in the channel may
	 * approve it.
	 */
	#approvers(minTier: Tier, speaker: Speaker | undefined): Audience {
		const { ownerId, identity } = this.#options;
		if (
			!identity ||
			!speaker ||
			speaker.id === ownerId ||
			!tierAtLeast(speaker.tier, minTier)
		)
			return {
				allows: (user) => user.id === ownerId,
				mentionId: ownerId,
				note: "",
				refusal: messages().cardOwnerOnly,
			};
		return {
			allows: async (user) => {
				if (user.id === ownerId) return true;
				if (user.id !== speaker.id) return false;
				// Their tier when they press, in case it was lowered during the turn.
				const who = await identity.resolve({
					provider: "discord",
					subject: user.id,
					name: user.name,
					surface: "discord",
					...(user.roleIds
						? { roles: user.roleIds.map((role) => `discord:role:${role}`) }
						: {}),
					legacyId: user.id,
				});
				return who !== undefined && tierAtLeast(who.tier, minTier);
			},
			mentionId: speaker.id,
			note: messages().cardApproversNote(speaker.id),
			refusal: messages().cardApproversRefusal,
		};
	}

	/** A question is for the speaker whose turn asks it, and for the owner. */
	#asker(speaker: Speaker | undefined): Audience {
		const { ownerId } = this.#options;
		if (!speaker || speaker.id === ownerId)
			return {
				allows: (user) => user.id === ownerId,
				mentionId: ownerId,
				note: "",
				refusal: messages().cardOwnerOnly,
			};
		return {
			allows: (user) => user.id === speaker.id || user.id === ownerId,
			mentionId: speaker.id,
			note: messages().cardAskerNote(speaker.id),
			refusal: messages().cardAskerRefusal,
		};
	}

	async handle(interaction: Interaction): Promise<boolean> {
		if (
			!(
				interaction.isButton() ||
				interaction.isStringSelectMenu() ||
				interaction.isModalSubmit()
			) ||
			!interaction.customId.startsWith(CARD_PREFIX)
		)
			return false;
		const [id = "", action = ""] = interaction.customId
			.slice(CARD_PREFIX.length)
			.split(":");
		const card = this.#open.get(id);
		if (!card) {
			await interaction.reply({
				content: messages().cardInactive,
				flags: MessageFlags.Ephemeral,
			});
			return true;
		}
		const { member } = interaction;
		const roleIds =
			member && "cache" in member.roles
				? [...member.roles.cache.keys()]
				: undefined;
		const user = {
			id: interaction.user.id,
			name: interaction.user.globalName ?? interaction.user.username,
			...(roleIds ? { roleIds } : {}),
		};
		if (!(await card.audience.allows(user))) {
			await interaction.reply({
				content: card.audience.refusal,
				flags: MessageFlags.Ephemeral,
			});
			return true;
		}
		const closed = (outcome: string) =>
			this.#panel(
				{
					title: card.title,
					sections: card.sections,
					rows: card.rows(true),
					footer: outcome,
				},
				card.mention === true,
				card.audience.mentionId,
			);
		if (interaction.isButton() && (action === "yes" || action === "no")) {
			const approved = action === "yes";
			card.end(approved ? "approved" : "declined");
			await interaction.update(
				closed(approved ? messages().cardApproved : messages().cardDeclined),
			);
			return true;
		}
		const question = card.question;
		if (!question) return true;
		if (interaction.isButton() && action === "write") {
			card.picked = [];
			await interaction.showModal(answerModal(id));
			return true;
		}
		if (interaction.isStringSelectMenu() && action === "pick") {
			const values = interaction.values;
			const choices = question.options.flatMap((option, i) =>
				values.includes(String(i)) ? [option.label] : [],
			);
			if (values.includes(OTHER)) {
				card.picked = choices;
				await interaction.showModal(answerModal(id));
				return true;
			}
			const answer = { choices };
			card.end(answer);
			await interaction.update(closed(answeredLine(answer)));
			return true;
		}
		if (interaction.isModalSubmit() && action === "text") {
			const answer = {
				choices: card.picked ?? [],
				text: interaction.fields.getTextInputValue(TEXT_FIELD),
			};
			card.end(answer);
			if (interaction.isFromMessage())
				await interaction.update(closed(answeredLine(answer)));
			else await interaction.deferUpdate();
			return true;
		}
		return true;
	}
}

/** A question's controls: a menu of its options, or a button that opens the answer form. */
function askRows(id: string, question: OwnerQuestion, disabled: boolean): Rows {
	if (question.options.length === 0)
		return [
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId(`${CARD_PREFIX}${id}:write`)
					.setLabel(messages().cardAnswerLabel)
					.setStyle(ButtonStyle.Primary)
					.setDisabled(disabled),
			),
		];
	// Discord menus take 25 options; "Other…" takes the last place when the options fill it.
	const options = question.options
		.slice(0, question.allowOther ? 24 : 25)
		.map((option, i) => ({
			label: option.label.slice(0, 100),
			value: String(i),
			...(option.description
				? { description: option.description.slice(0, 100) }
				: {}),
		}));
	if (question.allowOther)
		options.push({
			label: messages().cardOtherLabel,
			value: OTHER,
			description: messages().cardOtherDescription,
		});
	return [
		new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
			new StringSelectMenuBuilder()
				.setCustomId(`${CARD_PREFIX}${id}:pick`)
				.setPlaceholder(
					question.multi
						? messages().cardPickManyPlaceholder
						: messages().cardPickOnePlaceholder,
				)
				.setMinValues(1)
				.setMaxValues(question.multi ? options.length : 1)
				.addOptions(options)
				.setDisabled(disabled),
		),
	];
}

function answerModal(id: string): ModalBuilder {
	return new ModalBuilder()
		.setCustomId(`${CARD_PREFIX}${id}:text`)
		.setTitle(messages().cardModalTitle)
		.addLabelComponents(
			new LabelBuilder()
				.setLabel(messages().cardModalField)
				.setTextInputComponent(
					new TextInputBuilder()
						.setCustomId(TEXT_FIELD)
						.setStyle(TextInputStyle.Paragraph)
						.setRequired(true)
						.setMaxLength(1000),
				),
		);
}

function answeredLine(answer: OwnerAnswer): string {
	const parts = [
		...answer.choices.map(plain),
		...(answer.text !== undefined
			? [messages().cardQuote(plain(answer.text))]
			: []),
	];
	return messages().cardAnswered(parts);
}
