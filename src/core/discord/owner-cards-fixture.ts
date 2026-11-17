import { ChannelType, type Interaction } from "discord.js";
import { CARD_PREFIX, type CardPayload } from "./owner-cards.ts";

/** The primary owner of the cards' tests. */
export const OWNER = "100000000000000001";

/** The card's JSON, where its text, custom ids, and disabled flags can be read. */
export const json = (payload: CardPayload | undefined) =>
	JSON.stringify(payload?.components.map((c) => c.toJSON()));

/** A channel, or a thread, that records the cards sent to it and every edit of them. */
export function fakeChannel(thread = false) {
	const sent: CardPayload[] = [];
	const edits: CardPayload[] = [];
	/** The index in `sent` of the card each edit changed. */
	const edited: number[] = [];
	return {
		sent,
		edits,
		edited,
		/** The id of the latest card sent. */
		cardId: () =>
			json(sent.at(-1)).match(new RegExp(`${CARD_PREFIX}([0-9a-f-]+):`))?.[1] ??
			"",
		channel: async () => ({
			thread,
			send: async (payload: CardPayload) => {
				sent.push(payload);
				const index = sent.length - 1;
				return {
					edit: async (change: CardPayload) => {
						edits.push(change);
						edited.push(index);
					},
				};
			},
		}),
	};
}

export type Kind = "button" | "select" | "modal";

/** A press of a card's control, recording how it was answered. */
export function press(
	kind: Kind,
	customId: string,
	options: {
		user?: string;
		roles?: string[];
		values?: string[];
		text?: string;
		/** A form's fields by custom id; when given, a field not named reads empty. */
		fields?: Record<string, string>;
		/** Holds `deferUpdate` until it resolves, so the card can change while the press is in flight. */
		gate?: Promise<void>;
		/**
		 * The thread the card sits in: its parent and the parent's kind. `uncached` leaves the parent
		 * out of the client's cache, so reading it is a fetch that never resolves.
		 */
		thread?: { parentId: string; forum: boolean; uncached?: boolean };
	} = {},
) {
	/** Every response and fetch the press made, in the order it was called (not settled). */
	const calls: string[] = [];
	const replies: string[] = [];
	/** Everything a reply carried besides its text. */
	const replied: { files?: unknown[]; flags?: unknown }[] = [];
	const updates: CardPayload[] = [];
	const modals: unknown[] = [];
	/** What the press answered after deferring: edits of the card, and follow-ups. */
	const edited: CardPayload[] = [];
	const followUps: { content?: string; flags?: unknown }[] = [];
	const deferred: string[] = [];
	/** The card as the press drew it, by `update` or, once deferred, `editReply`, in order. */
	const drawn: CardPayload[] = [];
	/** What the press told its presser alone, by `reply` or, once deferred, `followUp`, in order. */
	const notices: (string | undefined)[] = [];
	// SAFETY: the cards read only these members of an interaction.
	const interaction = {
		isButton: () => kind === "button",
		isStringSelectMenu: () => kind === "select",
		isModalSubmit: () => kind === "modal",
		isFromMessage: () => true,
		customId,
		inGuild: () => true,
		guildId: "300000000000000003",
		message: { id: "400000000000000004" },
		channel: options.thread
			? {
					isThread: () => true,
					parentId: options.thread.parentId,
					parent: options.thread.uncached
						? null
						: {
								type: options.thread.forum
									? ChannelType.GuildForum
									: ChannelType.GuildText,
							},
					guild: {
						channels: {
							fetch: () => {
								calls.push("fetch");
								return new Promise(() => {});
							},
						},
					},
				}
			: null,
		user: { id: options.user ?? OWNER },
		member: {
			roles: { cache: new Map((options.roles ?? []).map((r) => [r, r])) },
		},
		values: options.values ?? [],
		fields: {
			getTextInputValue: (name: string) =>
				options.fields ? (options.fields[name] ?? "") : (options.text ?? ""),
		},
		reply: async (answer: {
			content: string;
			files?: unknown[];
			flags?: unknown;
		}) => {
			calls.push("reply");
			replies.push(answer.content);
			notices.push(answer.content);
			replied.push(answer);
		},
		update: async (payload: CardPayload) => {
			calls.push("update");
			updates.push(payload);
			drawn.push(payload);
		},
		showModal: async (modal: unknown) => {
			calls.push("showModal");
			modals.push(modal);
		},
		deferUpdate: async () => {
			calls.push("deferUpdate");
			await options.gate;
			deferred.push("update");
		},
		editReply: async (payload: CardPayload) => {
			calls.push("editReply");
			edited.push(payload);
			drawn.push(payload);
		},
		followUp: async (answer: { content?: string; flags?: unknown }) => {
			calls.push("followUp");
			followUps.push(answer);
			notices.push(answer.content);
		},
	} as unknown as Interaction;
	return {
		interaction,
		calls,
		replies,
		replied,
		updates,
		modals,
		edited,
		followUps,
		deferred,
		drawn,
		notices,
	};
}

/** Lets a posted card settle. */
export const tick = () => Bun.sleep(1);
