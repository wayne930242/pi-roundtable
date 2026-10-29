import { ConfigError, type Logger } from "pi-roundtable";
import type { NoticeView, ServerFrame } from "../api-types.ts";
import type { PushDispatch } from "../push/dispatch.ts";
import type { Notices, OpenTarget } from "../web-app.ts";
import type { NoticeFor, NoticeStore } from "./store.ts";
import { openUrl, type RoutingOptions } from "./urls.ts";

const MAX_TAG = 200;
const MAX_TITLE = 200;
const MAX_BODY = 2000;
const MAX_RECIPIENTS = 500;
const PAGE_ID = /^[a-z0-9-]{1,40}$/;

export interface NoticeServiceOptions {
	store: NoticeStore;
	dispatch: PushDispatch;
	/** Puts a frame on the open sockets of one person. */
	deliver(frame: ServerFrame, principalId: string): void;
	routing: RoutingOptions;
	logger: Logger;
}

/** A notice as the bell shows it. */
export function viewOf(notice: NoticeFor): NoticeView {
	return {
		tag: notice.tag,
		title: notice.title,
		...(notice.body ? { body: notice.body } : {}),
		...(notice.open
			? {
					open:
						"room" in notice.open
							? {
									room: notice.open.room,
									...(notice.open.message === undefined
										? {}
										: { message: notice.open.message }),
								}
							: {
									page: notice.open.page,
									...(notice.open.query
										? { query: { ...notice.open.query } }
										: {}),
								},
				}
			: {}),
		urgency: notice.urgency,
		ackable: notice.ackable,
		raisedAt: notice.raisedAt.toISOString(),
		...(notice.ackedAt ? { acked: true as const } : {}),
	};
}

const refuse = (message: string): never => {
	throw new ConfigError(`notices: ${message}`);
};

function checkOpen(open: OpenTarget | undefined): void {
	if (!open) return;
	if ("room" in open) {
		if (typeof open.room !== "string" || open.room.length === 0)
			refuse("open.room must be a room key");
		if (
			open.message !== undefined &&
			!(Number.isSafeInteger(open.message) && open.message >= 0)
		)
			refuse("open.message must be a message id");
	} else if (!PAGE_ID.test(open.page))
		refuse("open.page must match [a-z0-9-]{1,40}");
}

/**
 * The notices of the host: person-addressed, with state. A notice is a row the bell shows to its
 * addressees and, when push is on, a push to their devices; the badge is the count of those that
 * ask for an answer and have none. Everything a person can do to it (read, answer) is checked
 * against the addressee list, which only the host changes.
 */
export class NoticeService implements Notices {
	readonly #options: NoticeServiceOptions;
	readonly #listeners = new Set<(tag: string, principalId: string) => void>();

	constructor(options: NoticeServiceOptions) {
		this.#options = options;
	}

	async raise(notice: Parameters<Notices["raise"]>[0]): Promise<void> {
		const { store } = this.#options;
		const to = [...new Set(notice.to)];
		if (notice.tag.length === 0 || notice.tag.length > MAX_TAG)
			refuse(`the tag must be 1 to ${MAX_TAG} characters`);
		if (to.length === 0 || to.length > MAX_RECIPIENTS)
			refuse(`a notice goes to 1 to ${MAX_RECIPIENTS} people`);
		if (notice.title.length === 0 || notice.title.length > MAX_TITLE)
			refuse(`the title must be 1 to ${MAX_TITLE} characters`);
		if ((notice.body?.length ?? 0) > MAX_BODY)
			refuse(`the body is longer than ${MAX_BODY} characters`);
		checkOpen(notice.open);
		this.#checkVia(notice.via);
		await store.raise(
			{
				tag: notice.tag,
				title: notice.title,
				...(notice.body ? { body: notice.body } : {}),
				...(notice.open ? { open: notice.open } : {}),
				urgency: notice.urgency,
				ackable: notice.ackable === true,
			},
			to,
		);
		await Promise.all(
			to.map((principalId) =>
				this.#tell(notice.tag, principalId, {
					push: notice.push !== false,
					...(notice.via ? { via: notice.via } : {}),
				}),
			),
		);
	}

	async renotify(
		tag: string,
		add: readonly string[] = [],
		options: { via?: readonly string[] } = {},
	): Promise<void> {
		this.#checkVia(options.via);
		const people = await this.#options.store.renotify(tag, [...new Set(add)]);
		if (!people) return;
		await Promise.all(
			people.map((principalId) =>
				this.#tell(tag, principalId, {
					push: true,
					...(options.via ? { via: options.via } : {}),
				}),
			),
		);
	}

	async resolve(
		tag: string,
		by?: { principalId?: string; reason: string },
	): Promise<void> {
		const { store } = this.#options;
		const before = new Map<string, NoticeFor | undefined>();
		const open = (await store.pending(tag))?.to ?? [];
		for (const principalId of open)
			before.set(principalId, await store.of(tag, principalId));
		const people = await store.resolve(tag, by);
		if (!people) return;
		await Promise.all(
			people.map((principalId) =>
				this.#cleared(tag, principalId, before.get(principalId)),
			),
		);
	}

	/** Tells one addressee's pages and devices a notice is gone. */
	async #cleared(
		tag: string,
		principalId: string,
		was: NoticeFor | undefined,
	): Promise<void> {
		const { store, dispatch, routing } = this.#options;
		this.#options.deliver({ type: "notice_resolved", tag }, principalId);
		const count = await this.#sendBadge(principalId);
		// Only a device that was pushed this notice has something to close.
		if (await store.delivered(tag, principalId))
			await dispatch.clear(
				principalId,
				tag,
				openUrl(was?.open, routing),
				count,
			);
	}

	pending(tag: string): ReturnType<Notices["pending"]> {
		return this.#options.store.pending(tag);
	}

	onAck(listener: (tag: string, principalId: string) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	// ── What the person does ──

	/** The person's open notices and their count. */
	async listFor(
		principalId: string,
	): Promise<{ notices: NoticeView[]; badge: number }> {
		const { store } = this.#options;
		const [notices, badge] = await Promise.all([
			store.openFor(principalId),
			store.unhandled(principalId),
		]);
		return { notices: notices.map(viewOf), badge };
	}

	/** The person handled a notice; false when it is not theirs, is closed, or asks for no answer. */
	async ack(tag: string, principalId: string): Promise<boolean> {
		const { store, dispatch, routing } = this.#options;
		if (!(await store.ack(tag, principalId))) return false;
		const notice = await store.of(tag, principalId);
		if (notice)
			this.#options.deliver(
				{ type: "notice", notice: viewOf(notice) },
				principalId,
			);
		const count = await this.#sendBadge(principalId);
		// Their other devices stop showing it.
		if (await store.delivered(tag, principalId))
			await dispatch.clear(
				principalId,
				tag,
				openUrl(notice?.open, routing),
				count,
			);
		for (const listener of this.#listeners) {
			try {
				listener(tag, principalId);
			} catch (error) {
				this.#options.logger.warn({ err: error, tag }, "an ack listener threw");
			}
		}
		return true;
	}

	/** Records a receipt from the service worker; false when the notice is not addressed to the person. */
	receipt(
		tag: string,
		principalId: string,
		event: "received" | "opened",
	): Promise<boolean> {
		return this.#options.store.receipt(tag, principalId, event);
	}

	/** The count the app icon shows for the person: their notices not handled. */
	badge(principalId: string): Promise<number> {
		return this.#options.store.unhandled(principalId);
	}

	/** The frames a socket gets when it opens: every notice that is open for the person, and the count. */
	async frames(principalId: string): Promise<ServerFrame[]> {
		const { notices, badge } = await this.listFor(principalId);
		return [
			...notices.map((notice): ServerFrame => ({ type: "notice", notice })),
			{ type: "badge", count: badge },
		];
	}

	// ── Inside ──

	#checkVia(via: readonly string[] | undefined): void {
		if (!via) return;
		const known = this.#options.dispatch.transports;
		if (via.length === 0) refuse("via names no transport");
		for (const name of via)
			if (!known.includes(name))
				refuse(
					`via names ${JSON.stringify(name)}, but the sender has ${known.join(", ")}; list a host transport in push.transports`,
				);
	}

	async #sendBadge(principalId: string): Promise<number> {
		const count = await this.#options.store.unhandled(principalId);
		this.#options.deliver({ type: "badge", count }, principalId);
		return count;
	}

	/** Shows a notice to one addressee and, when asked, pushes it to their devices. */
	async #tell(
		tag: string,
		principalId: string,
		options: { push: boolean; via?: readonly string[] },
	): Promise<void> {
		const { store, dispatch, routing } = this.#options;
		const notice = await store.of(tag, principalId);
		if (!notice) return;
		this.#options.deliver(
			{ type: "notice", notice: viewOf(notice) },
			principalId,
		);
		const count = await this.#sendBadge(principalId);
		if (!options.push) return;
		await dispatch.notice(principalId, {
			tag,
			title: notice.title,
			...(notice.body ? { body: notice.body } : {}),
			open: openUrl(notice.open, routing),
			urgency: notice.urgency,
			badge: count,
			...(options.via ? { via: options.via } : {}),
		});
	}
}
