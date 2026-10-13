import { randomUUID } from "node:crypto";
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type Interaction,
	MessageFlags,
	TextDisplayBuilder,
} from "discord.js";
import { parseChannelKey } from "../contract/surface.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import { messages } from "../i18n/index.ts";
import type {
	Approval,
	OwnerAnswer,
	OwnerQuestion,
	PromptScope,
	Prompts,
	PromptWait,
} from "../interactions/prompts.ts";
import type { Logger } from "../log.ts";
import {
	type Audience,
	type CardAudienceOptions,
	CardAudiences,
} from "./card-audience.ts";
import { CardCopies, copyReply, offeredCopy } from "./card-copies.ts";
import { DiscordOwners, discordUser } from "./discord-owners.ts";
import type { InteractionModule } from "./interaction-module.ts";
import {
	answeredLine,
	answerModal,
	askRows,
	CARD_PREFIX,
	OTHER,
	type Rows,
	TEXT_FIELD,
} from "./owner-card-rows.ts";
import type {
	Answerer,
	CardChannel,
	CardMessage,
	CardPayload,
	LateTurn,
	OpenCard,
} from "./owner-card-types.ts";
import { ownerPanel, type PanelContent } from "./owner-panel.ts";

export type {
	CardChannel,
	CardPayload,
	LateTurn,
} from "./owner-card-types.ts";
export { CARD_PREFIX };
/** How long a turn that can be resumed waits on its card before it goes on without the answer. */
export const CARD_GRACE_MS = 2 * 60_000;

export interface OwnerCardsOptions {
	/** The primary owner's Discord user id. */
	ownerId: string;
	/**
	 * Who holds a tier now, and which owners have a Discord identity, for cards that others than
	 * the primary owner may answer; without it only the primary owner answers.
	 */
	identity?: CardAudienceOptions["identity"];
	/** The Discord channel by id; throws when it cannot take messages. */
	channel(channelId: string): Promise<CardChannel>;
	logger: Logger;
	/**
	 * How long a turn that gives a `PromptWait` waits on its card; `CARD_GRACE_MS` (two minutes)
	 * by default. The card stays open after it, for as long as the process runs.
	 */
	graceMs?: number;
	/**
	 * Starts a turn in a card's channel with a late answer's text, as a message from whoever
	 * answered. Without it no turn stops waiting on its cards.
	 */
	resume?(turn: LateTurn): void;
	/**
	 * A JSON file that keeps the text behind approval cards' copy buttons across restarts; without
	 * it a card's copy button stops working when the process restarts.
	 */
	copyLedgerPath?: string;
}

/**
 * The cards in the assistant's channels: approvals of held actions and ask_user questions,
 * answered with buttons, a menu, or a form, by those the turn's prompt scope names (see
 * `CardAudiences`): the speaker whose turn asks, when the card allows (a question always; an
 * approval at its tier), and, in a shared conversation, the owners. A turn that can be resumed
 * (it gives a `PromptWait`) waits on its card for the grace period, then goes on without the
 * answer while the card stays open; answered later, the card starts a turn in its channel with
 * the answer. Other cards wait for their answer. A stopped turn cancels a card it still waits on.
 * Open cards live in memory, so a restart abandons them; pressing one then says to ask again.
 */
export class OwnerCards implements InteractionModule {
	readonly #options: OwnerCardsOptions;
	readonly #audiences: CardAudiences;
	readonly #open = new Map<string, OpenCard>();
	readonly #copies: CardCopies;

	constructor(options: OwnerCardsOptions) {
		this.#options = options;
		this.#copies = new CardCopies({
			...(options.copyLedgerPath ? { path: options.copyLedgerPath } : {}),
			logger: options.logger,
		});
		this.#audiences = new CardAudiences(options, new DiscordOwners(options));
	}

	commands() {
		return [];
	}

	/**
	 * The channel's cards for the scope's turn; without a scope they are the owners'. The chat
	 * surface port sends only Discord keys here.
	 */
	prompts(channel: ChannelKey, scope?: PromptScope): Prompts | undefined {
		const channelId = parseChannelKey(channel).id;
		return {
			confirm: async (
				title,
				message,
				signal,
				minTier = "owner",
				wait,
				details,
				options,
			) => {
				const copy = offeredCopy(details?.copy, (chars) =>
					this.#options.logger.warn(
						{ channelId, chars },
						"card copy text too long; the card has no copy button",
					),
				);
				const audience = await this.#audiences.approval(
					scope,
					minTier,
					options?.approvers,
				);
				// A private conversation's call above its person's tier is no one's to approve.
				if (!audience) return "unavailable";
				return this.#post<Approval>(
					channelId,
					signal,
					"unavailable",
					"cancelled",
					{
						audience,
						...(wait
							? {
									wait: {
										pending: "pending",
										late: (value, by) =>
											wait.late({
												kind: "approval",
												approved: value === "approved",
												by: by.user.name,
												...(by.approver ? { approvedBy: by.approver } : {}),
											}),
									},
								}
							: {}),
						...(options?.approvedBy
							? {
									approved: (by: Answerer) => {
										if (by.approver) options.approvedBy?.(by.approver);
									},
								}
							: {}),
						title,
						sections: [message],
						...(copy ? { copy: copy.text } : {}),
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
								// Copying answers nothing, so it stays usable once the card has ended.
								...(copy
									? [
											new ButtonBuilder()
												.setCustomId(`${CARD_PREFIX}${id}:copy`)
												.setLabel(copy.label)
												.setEmoji("📋")
												.setStyle(ButtonStyle.Secondary),
										]
									: []),
							),
						],
						footer: messages().cardApprovalFooter,
					},
				);
			},
			ask: async (title, question, signal, wait) => {
				const audience = await this.#audiences.question(scope);
				if (!audience) return undefined;
				return this.#post<OwnerAnswer | "pending" | undefined>(
					channelId,
					signal,
					undefined,
					undefined,
					{
						audience,
						...(wait
							? {
									wait: {
										pending: "pending",
										late: (value, by) =>
											wait.late({
												kind: "question",
												answer: value as OwnerAnswer,
												by: by.user.name,
											}),
									},
								}
							: {}),
						title,
						sections: [question.question],
						question,
						rows: (id, disabled) => askRows(id, question, disabled),
						footer: messages().cardQuestionFooter,
					},
				);
			},
		};
	}

	/**
	 * Posts a card and resolves with its answer, `unposted` when it could not be posted, or
	 * `cancelled`; with `wait`, and a way to resume, `wait.pending` once the grace period passes.
	 */
	#post<T>(
		channelId: string,
		signal: AbortSignal | undefined,
		unposted: T,
		cancelled: T,
		card: {
			audience: Audience;
			title: string;
			sections: string[];
			/** The text behind the card's copy button, kept under the card's id. */
			copy?: string;
			question?: OwnerQuestion;
			rows(id: string, disabled: boolean): Rows;
			footer: string;
			wait?: {
				pending: T;
				late(value: unknown, by: Answerer): ReturnType<PromptWait["late"]>;
			};
			/** Hears who approved the card, before it resolves approved in its turn. */
			approved?(by: Answerer): void;
		},
	): Promise<T> {
		const { logger, graceMs = CARD_GRACE_MS, resume } = this.#options;
		if (signal?.aborted) return Promise.resolve(cancelled);
		const wait = resume ? card.wait : undefined;
		const id = randomUUID();
		if (card.copy !== undefined) this.#copies.remember(id, card.copy);
		const sections = [
			...card.sections,
			...(card.audience.note ? [card.audience.note] : []),
		];
		return new Promise<T>((resolve) => {
			let message: CardMessage | undefined;
			let finish: string | undefined;
			/** The turn went on without the answer; the card is the conversation's now. */
			let late = false;
			const settle = (value: T, outcome: string | undefined) => {
				if (!this.#open.delete(id)) return;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				if (late) return;
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
					card.audience.mentions,
				);
			const abort = () => settle(cancelled, messages().cardStopped);
			const timer = wait
				? setTimeout(() => {
						if (!this.#open.has(id)) return;
						late = true;
						signal?.removeEventListener("abort", abort);
						resolve(wait.pending);
					}, graceMs)
				: undefined;
			signal?.addEventListener("abort", abort, { once: true });
			const open: OpenCard = {
				title: card.title,
				sections,
				rows: (disabled) => card.rows(id, disabled),
				audience: card.audience,
				end: (value, by) => {
					const answeredLate = late;
					if (value === "approved" && !answeredLate) card.approved?.(by);
					settle(value as T, undefined);
					if (!answeredLate || !wait || !resume) return;
					try {
						const text = wait.late(value, by);
						if (text === undefined) return;
						resume({
							channelId,
							messageId: by.messageId ?? `card-${id}`,
							user: by.user,
							...(by.guildId ? { guildId: by.guildId } : {}),
							isDirect: by.isDirect,
							text,
						});
					} catch (error) {
						logger.warn({ channelId, err: error }, "late card answer lost");
					}
				},
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
					settle(unposted, undefined);
				});
		});
	}

	/** The card's panel; in a thread it leads with the mention of who may answer. */
	#panel(
		content: PanelContent,
		mention: boolean,
		userIds: readonly string[],
	): CardPayload {
		const panel = ownerPanel(content);
		if (!mention) return panel;
		return {
			...panel,
			components: [
				new TextDisplayBuilder().setContent(
					userIds.map((id) => `<@${id}>`).join(" "),
				),
				...panel.components,
			],
			allowedMentions: { users: [...userIds] },
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
		// Copying answers nothing: anyone who sees the card may copy, as often as they like, also
		// once the card has ended or the process restarted.
		if (interaction.isButton() && action === "copy") {
			const text = this.#copies.recall(id);
			await interaction.reply(
				text === undefined
					? { content: messages().cardCopyGone, flags: MessageFlags.Ephemeral }
					: copyReply(text),
			);
			return true;
		}
		const card = this.#open.get(id);
		if (!card) {
			await interaction.reply({
				content: messages().cardInactive,
				flags: MessageFlags.Ephemeral,
			});
			return true;
		}
		const user = discordUser(interaction);
		const by: Answerer = {
			user,
			...(interaction.message ? { messageId: interaction.message.id } : {}),
			...(interaction.guildId ? { guildId: interaction.guildId } : {}),
			isDirect: !interaction.inGuild(),
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
				card.audience.mentions,
			);
		if (interaction.isButton() && (action === "yes" || action === "no")) {
			const approved = action === "yes";
			const approver = approved
				? await card.audience.approver?.(user).catch((error: unknown) => {
						this.#options.logger.warn(
							{ err: error },
							"could not tell who approved; the call runs without an approver",
						);
						return undefined;
					})
				: undefined;
			card.end(
				approved ? "approved" : "declined",
				approver ? { ...by, approver } : by,
			);
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
			card.end(answer, by);
			await interaction.update(closed(answeredLine(answer)));
			return true;
		}
		if (interaction.isModalSubmit() && action === "text") {
			const answer = {
				choices: card.picked ?? [],
				text: interaction.fields.getTextInputValue(TEXT_FIELD),
			};
			card.end(answer, by);
			if (interaction.isFromMessage())
				await interaction.update(closed(answeredLine(answer)));
			else await interaction.deferUpdate();
			return true;
		}
		return true;
	}
}
