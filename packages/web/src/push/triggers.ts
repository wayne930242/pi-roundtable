import type { IdentityService, Logger } from "pi-roundtable";
import type { NewOutboxRow, PushOutbox } from "./outbox.ts";
import type { PushPayload, PushSender, SendResult } from "./sender.ts";
import type { PushSubscriptions, Subscription } from "./subscriptions.ts";

/** The most characters of a message a notification shows. */
export const PREVIEW_CHARS = 120;
/** Replies in one room closer together than this share a notification. */
const REPLY_QUIET_MS = 15_000;

/**
 * Where the push goes when the app does not sign it: the outbox an external sender empties. The
 * app then holds no VAPID key and a row carries a title and a preview only with `content: "full"`.
 */
export interface OutboxRoute {
	outbox: Pick<PushOutbox, "enqueue">;
	content: "full" | "none";
	/** The count the app icon shows for the person: their notices not handled. */
	badge(principalId: string): Promise<number>;
}

export interface PushServiceOptions {
	subscriptions: Pick<
		PushSubscriptions,
		"all" | "delivered" | "forget" | "failed"
	>;
	/** Signs and sends in this process; absent when `route` queues the pushes for an external sender. */
	sender?: Pick<PushSender, "send">;
	/** Queue the pushes instead of signing them here; absent = sign and send in this process. */
	route?: OutboxRoute;
	identity: Pick<IdentityService, "tierOf">;
	/** Whether a page of this person is in view now; their devices are not pushed while one is. */
	visible(principalId: string): boolean;
	/** Whether a notification shows the start of the message; false sends titles only. */
	preview: boolean;
	/** The path a tap on a room's notification opens, under the origin. */
	urlOf(room: string): string;
	logger: Logger;
	/** The clock, in milliseconds; default `Date.now`. */
	now?: () => number;
	/**
	 * Whether a moment, in milliseconds, is in the quiet hours: an agent's post and a notice are
	 * not pushed then, while a card is. Default never.
	 */
	quiet?: (at: number) => boolean;
	/**
	 * Whether the owners muted a room: an agent's post in it is not pushed, while a
	 * card is. Default never.
	 */
	muted?: (room: string) => Promise<boolean>;
	/** Whether a room is a host's: those reach phones only through notices, never through a card or reply push. */
	hostRoom?: (room: string) => boolean;
}

/** What a trigger says; the service shapes it into a notification. */
interface Event {
	kind: PushPayload["kind"];
	title: string;
	/** The text a notification shows when previews are on. */
	text?: string;
	room?: string;
	tag: string;
	/** Only this person's devices; default every owner's. */
	principalId?: string;
}

/** The start of a message, on one line and cut at `PREVIEW_CHARS`. */
export function previewOf(text: string): string {
	const flat = text.replaceAll(/\s+/g, " ").trim();
	const letters = Array.from(flat);
	return letters.length > PREVIEW_CHARS
		? `${letters.slice(0, PREVIEW_CHARS).join("")}…`
		: flat;
}

/**
 * Decides when an owner's devices are pushed and what is said. Each trigger pushes only while no
 * page of an owner is in view, and only to owners: a device whose person is no owner any more is
 * skipped. In the quiet hours an agent's post and a notice wait for the owner to look; in a room the
 * owners muted only the post does. A card, which holds up work, is still pushed. Delivery never throws into the code that raised the trigger.
 */
export class PushService {
	readonly #options: PushServiceOptions;
	readonly #repliedAt = new Map<string, number>();

	constructor(options: PushServiceOptions) {
		this.#options = options;
	}

	/** A card opened in a room: an approval or a question waits for an owner. */
	card(room: string, title: string, longRunningCap: boolean): Promise<void> {
		if (this.#options.hostRoom?.(room)) return Promise.resolve();
		return this.#push({
			kind: longRunningCap ? "cap" : "card",
			title: longRunningCap ? "Long-running cap reached" : "Card waiting",
			text: title,
			room,
			tag: room,
		});
	}

	/** An agent posted in a room, such as a finished job's report or an answer nobody was watching for. */
	async reply(room: string, author: string, text: string): Promise<void> {
		if (this.#options.hostRoom?.(room)) return;
		const now = this.#now();
		if (this.#options.quiet?.(now)) return;
		if (await this.#muted(room)) return;
		const last = this.#repliedAt.get(room);
		if (last !== undefined && now - last < REPLY_QUIET_MS) return;
		this.#repliedAt.set(room, now);
		await this.#push({
			kind: "reply",
			title: this.#options.preview ? author : "New reply",
			text,
			room,
			tag: room,
		});
	}

	/** A notice for one person, from the `notify` tool. A mute does not hold it back: a notice is addressed to the person, and it always names the home room. */
	async notice(
		principalId: string,
		text: string,
		room?: string,
	): Promise<void> {
		if (this.#options.quiet?.(this.#now())) return;
		await this.#push({
			kind: "notice",
			title: "Notice",
			text,
			...(room ? { room } : {}),
			tag: room ?? "notice",
			principalId,
		});
	}

	/** Whether the room is muted; a mute that cannot be read leaves the owner's pushes on, with a warning. */
	async #muted(room: string): Promise<boolean> {
		try {
			return (await this.#options.muted?.(room)) ?? false;
		} catch (error) {
			this.#options.logger.warn({ err: error, room }, "a mute was not read");
			return false;
		}
	}

	#now(): number {
		return (this.#options.now ?? Date.now)();
	}

	async #push(event: Event): Promise<void> {
		const { logger, preview } = this.#options;
		try {
			const payload: PushPayload = {
				kind: event.kind,
				title: event.title,
				tag: event.tag,
				...(event.room
					? { room: event.room, url: this.#options.urlOf(event.room) }
					: {}),
				...(preview && event.text ? { body: previewOf(event.text) } : {}),
			};
			const targets = await this.#targets(event.principalId);
			if (this.#options.route) {
				await this.#queue(this.#options.route, event, payload, targets);
				return;
			}
			const { sender } = this.#options;
			if (!sender) return;
			await Promise.all(
				targets.map(async (target) =>
					this.#settle(target, await sender.send(target, payload)),
				),
			);
		} catch (error) {
			logger.warn({ err: error, kind: event.kind }, "a push was not sent");
		}
	}

	/** One outbox row for each person the push reaches; the sender finds their devices. */
	async #queue(
		route: OutboxRoute,
		event: Event,
		payload: PushPayload,
		targets: readonly Subscription[],
	): Promise<void> {
		const people = [...new Set(targets.map((target) => target.principalId))];
		await Promise.all(
			people.map(async (principalId) => {
				const row: NewOutboxRow = {
					kind: payload.kind === "cap" ? "card" : payload.kind,
					tag: payload.tag,
					principalId,
					open: payload.url ?? "",
					urgency: payload.kind === "reply" ? "normal" : "high",
					badge: await route.badge(principalId),
					...(route.content === "full"
						? {
								title: event.title,
								...(payload.body ? { body: payload.body } : {}),
							}
						: {}),
				};
				await route.outbox.enqueue(row);
			}),
		);
	}

	async #targets(principalId?: string): Promise<Subscription[]> {
		const owners = new Map<string, boolean>();
		const isOwner = async (id: string): Promise<boolean> => {
			const known = owners.get(id);
			if (known !== undefined) return known;
			const owner = (await this.#options.identity.tierOf(id)) === "owner";
			owners.set(id, owner);
			return owner;
		};
		const all = await this.#options.subscriptions.all();
		const chosen: Subscription[] = [];
		for (const subscription of all)
			if (
				(principalId === undefined ||
					subscription.principalId === principalId) &&
				!this.#options.visible(subscription.principalId) &&
				(await isOwner(subscription.principalId))
			)
				chosen.push(subscription);
		return chosen;
	}

	async #settle(target: Subscription, result: SendResult): Promise<void> {
		const { subscriptions } = this.#options;
		if (result === "sent") await subscriptions.delivered(target.endpoint);
		else if (result === "gone") await subscriptions.forget(target.endpoint);
		else await subscriptions.failed(target.endpoint);
	}
}
