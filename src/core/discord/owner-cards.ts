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
import {
	DiscordOwners,
	type DiscordUser,
	discordUser,
} from "./discord-owners.ts";
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
import { ownerPanel, type PanelContent } from "./owner-panel.ts";

export { CARD_PREFIX };
/** How long a turn that can be resumed waits on its card before it goes on without the answer. */
export const CARD_GRACE_MS = 2 * 60_000;

/** A card's message: the panel, led in a thread by a mention of those it is for. */
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
	/** A thread, where those a card is for are mentioned so they hear of it; a channel mentions no one. */
	thread?: boolean;
}

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
}

/** A turn a card answered after its turn stopped waiting starts, as a message in its channel. */
export interface LateTurn {
	channelId: string;
	/** The card's message, which the turn's message stands for. */
	messageId: string;
	/** Who answered. */
	user: DiscordUser;
	/** The server the channel belongs to; absent in a direct message. */
	guildId?: string;
	isDirect: boolean;
	text: string;
}

/** Where and by whom a card was answered. */
interface Answerer {
	user: DiscordUser;
	messageId?: string;
	guildId?: string;
	isDirect: boolean;
}

/** One open card: how it looks, and how it ends. */
interface OpenCard {
	title: string;
	sections: string[];
	/** The card's controls, disabled once it has ended. */
	rows(disabled: boolean): Rows;
	/**
	 * Ends the card with its answer; the answering interaction shows the outcome. A card whose
	 * turn stopped waiting starts a turn with the answer instead.
	 */
	end(value: unknown, by: Answerer): void;
	question?: OwnerQuestion;
	/** Options chosen together with "Other…", kept while its form is open. */
	picked?: string[];
	/** Posted in a thread, so it leads with the mention of who may answer. */
	mention?: boolean;
	/** Who may answer, and what to tell someone else who presses it. */
	audience: Audience;
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

	constructor(options: OwnerCardsOptions) {
		this.#options = options;
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
			confirm: async (title, message, signal, minTier = "owner", wait) => {
				const audience = await this.#audiences.approval(scope, minTier);
				// A private conversation's call above its person's tier is no one's to approve.
				if (!audience) return "expired";
				return this.#post<Approval>(channelId, signal, "expired", "cancelled", {
					audience,
					...(wait
						? {
								wait: {
									pending: "pending",
									late: (value, by) =>
										wait.late({
											kind: "approval",
											approved: value === "approved",
											by,
										}),
								},
							}
						: {}),
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
				});
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
												by,
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
	 * Posts a card and resolves with its answer, `expired` when it could not be posted, or
	 * `cancelled`; with `wait`, and a way to resume, `wait.pending` once the grace period passes.
	 */
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
			wait?: {
				pending: T;
				late(value: unknown, by: string): ReturnType<PromptWait["late"]>;
			};
		},
	): Promise<T> {
		const { logger, graceMs = CARD_GRACE_MS, resume } = this.#options;
		if (signal?.aborted) return Promise.resolve(cancelled);
		const wait = resume ? card.wait : undefined;
		const id = randomUUID();
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
					settle(value as T, undefined);
					if (!answeredLate || !wait || !resume) return;
					try {
						const text = wait.late(value, by.user.name);
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
					settle(expired, undefined);
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
			card.end(approved ? "approved" : "declined", by);
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
