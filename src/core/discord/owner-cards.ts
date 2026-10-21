import { randomUUID } from "node:crypto";
import { type Interaction, MessageFlags, TextDisplayBuilder } from "discord.js";
import { parseChannelKey } from "../contract/surface.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import { messages } from "../i18n/index.ts";
import type {
	Approval,
	PromptScope,
	Prompts,
} from "../interactions/prompts.ts";
import type { Logger } from "../log.ts";
import { type CardAudienceOptions, CardAudiences } from "./card-audience.ts";
import { CardCopies, copyReply, offeredCopy } from "./card-copies.ts";
import { DiscordOwners, discordUser } from "./discord-owners.ts";
import type { InteractionModule } from "./interaction-module.ts";
import {
	answerDeferred,
	answerForm,
	answerSingle,
	showPreviews,
} from "./owner-card-answers.ts";
import { askPrompts } from "./owner-card-asks.ts";
import {
	approvalRows,
	CARD_PREFIX,
	withdrawnFooter,
} from "./owner-card-rows.ts";
import type {
	Answerer,
	CardChannel,
	CardMessage,
	CardPayload,
	CardSpec,
	LateTurn,
	OpenCard,
} from "./owner-card-types.ts";
import { ownerPanel } from "./owner-panel.ts";

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
	 * Where and how long the text behind approval cards' copy buttons is kept. With a `path` it is
	 * a JSON file that survives a restart; without one the texts live in memory and a card's copy
	 * button stops working when the process restarts. `keep` (default 100) is how many cards'
	 * texts, the newest, and `keepDays` (default 30) how long.
	 */
	copies?: { path?: string; keep?: number; keepDays?: number };
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
			...options.copies,
			logger: options.logger,
		});
		this.#audiences = new CardAudiences(options, new DiscordOwners(options));
	}
	/** Resolves once the remembered copy texts are on disk. */
	flushCopies = (): Promise<void> => this.#copies.flush();
	startCopies = (): void => this.#copies.start();
	stopCopies = (): Promise<void> => this.#copies.stop();

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
			...askPrompts({
				channelId,
				scope,
				audiences: this.#audiences,
				post: (c, s, u, x, card) => this.#post(c, s, u, x, card),
			}),
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
					options?.speakerOnly === true,
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
										late: (value, by, prompt) =>
											wait.late({
												kind: "approval",
												approved: value === "approved",
												by: by.user.name,
												...(by.approver ? { approvedBy: by.approver } : {}),
												prompt,
											}),
									},
								}
							: {}),
						approved: (by: Answerer, prompt: string) => {
							if (by.approver) options?.approvedBy?.(by.approver);
							options?.approvedPrompt?.(prompt);
						},
						title,
						sections: [message],
						...(options?.supersede ? { supersede: options.supersede } : {}),
						...(copy ? { copy: copy.text } : {}),
						rows: (id, disabled) =>
							approvalRows(id, disabled, copy, options?.wording),
						footer: options?.wording?.footer ?? messages().cardApprovalFooter,
						...(options?.wording ? { outcomes: options.wording } : {}),
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
		card: CardSpec<T>,
	): Promise<T> {
		const { logger, graceMs = CARD_GRACE_MS, resume } = this.#options;
		if (signal?.aborted || card.supersede?.aborted)
			return Promise.resolve(cancelled);
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
			/** Shows the card as ended with `footer`, or once it is posted. */
			const close = (footer: string) => {
				finish = footer;
				void message
					?.edit(view(footer))
					.catch((error: unknown) =>
						logger.warn({ channelId, err: error }, "card not closed"),
					);
			};
			const settle = (value: T, outcome: string | undefined) => {
				if (!this.#open.delete(id)) return;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				card.supersede?.removeEventListener("abort", withdraw);
				if (late) return;
				// A card ended by an answer is edited by the answering interaction.
				if (outcome !== undefined) close(outcome);
				resolve(value);
			};
			const view = (footer: string, disabled = true) =>
				this.#panel(
					card.build?.(id, footer, disabled) ??
						ownerPanel({
							title: card.title,
							sections,
							rows: card.rows?.(id, disabled) ?? [],
							footer,
						}),
					open.mention === true,
					card.audience.mentions,
				);
			const abort = () => settle(cancelled, messages().cardStopped);
			/** The plugin withdrew the call: the card closes, its turn waiting or not, unless an answer came first. */
			const withdraw = () => {
				if (!this.#open.delete(id) || !card.supersede) return;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				close(withdrawnFooter(card.supersede));
				if (!late) resolve(cancelled);
			};
			const arm = () =>
				wait
					? setTimeout(() => {
							if (!this.#open.has(id)) return;
							late = true;
							signal?.removeEventListener("abort", abort);
							resolve(wait.pending);
						}, graceMs)
					: undefined;
			let timer = arm();
			signal?.addEventListener("abort", abort, { once: true });
			card.supersede?.addEventListener("abort", withdraw, { once: true });
			const open: OpenCard = {
				view,
				isOpen: () => this.#open.has(id),
				touch: () => {
					if (late || !this.#open.has(id)) return;
					clearTimeout(timer);
					timer = arm();
				},
				audience: card.audience,
				end: (value, by) => {
					// Withdrawn or answered already: this answer changes nothing.
					if (!this.#open.has(id)) return false;
					const answeredLate = late;
					if (value === "approved" && !answeredLate) card.approved?.(by, id);
					settle(value as T, undefined);
					if (!answeredLate || !wait || !resume) return true;
					try {
						const text = wait.late(value, by, id);
						if (text === undefined) return true;
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
					return true;
				},
				...(card.question ? { question: card.question } : {}),
				...(card.form ? { form: card.form } : {}),
				...(card.previews ? { previews: card.previews } : {}),
				...(card.outcomes ? { outcomes: card.outcomes } : {}),
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
		panel: CardPayload,
		mention: boolean,
		userIds: readonly string[],
	): CardPayload {
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
		const [id = "", action = "", index = ""] = interaction.customId
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
		if (action === "previews") {
			await showPreviews(card, interaction);
			return true;
		}
		const user = discordUser(interaction);
		const by: Answerer = {
			user,
			...(interaction.message ? { messageId: interaction.message.id } : {}),
			...(interaction.guildId ? { guildId: interaction.guildId } : {}),
			isDirect: !interaction.inGuild(),
		};
		// A menu pick or Submit is deferred before the audience is looked up, which may take a while.
		if (
			card.form &&
			(action === "qpick" || action === "submit" || action === "qtext")
		) {
			await answerDeferred(card, action, Number(index), interaction, by);
			return true;
		}
		if (!(await card.audience.allows(user))) {
			await interaction.reply({
				content: card.audience.refusal,
				flags: MessageFlags.Ephemeral,
			});
			return true;
		}
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
			const accepted = card.end(
				approved ? "approved" : "declined",
				approver ? { ...by, approver } : by,
			);
			// The plugin withdrew the call, or another press answered, while this one was being checked.
			if (!accepted) {
				await interaction.reply({
					content: messages().cardInactive,
					flags: MessageFlags.Ephemeral,
				});
				return true;
			}
			await interaction.update(
				card.view(
					approved
						? (card.outcomes?.approved ?? messages().cardApproved)
						: (card.outcomes?.declined ?? messages().cardDeclined),
				),
			);
			return true;
		}
		if (card.form) await answerForm(card, id, action, interaction);
		else await answerSingle(card, id, action, interaction, by);
		return true;
	}
}
