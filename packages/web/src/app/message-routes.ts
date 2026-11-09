import type { ChannelKey } from "pi-roundtable";
import type { MessagesView } from "../api-types.ts";
import { isStartOver } from "../api-types.ts";
import type { Authenticated } from "../auth/authenticator.ts";
import { readsOf, withExpiredFiles } from "../host/room-views.ts";
import { json } from "../http.ts";
import { bad, notFound } from "./api-http.ts";
import { PAGE_LIMIT } from "./room-log.ts";
import type { ResolvedRoom } from "./rooms.ts";

import type { AppApiOptions } from "./routes-options.ts";

type MessageApiOptions = Pick<
	AppApiOptions,
	"log" | "cards" | "reads" | "nameOf" | "surface" | "files"
>;

/** A room's messages, a page at a time: the live conversation or an archived one. */
export class MessageApi {
	readonly #options: MessageApiOptions;

	constructor(options: MessageApiOptions) {
		this.#options = options;
	}

	/** `GET rooms/<key>/messages`: a page of the live conversation, or of an archived one with `archive`. */
	async page(
		request: Request,
		room: ResolvedRoom,
		admission: Authenticated,
	): Promise<Response> {
		const { log, cards } = this.#options;
		const params = new URL(request.url).searchParams;
		const before = params.get("before");
		const limit = params.get("limit");
		const archive = params.get("archive");
		const beforeId = before === null ? undefined : Number(before);
		const archiveId = archive === null ? undefined : Number(archive);
		const count = limit === null ? PAGE_LIMIT : Number(limit);
		if (
			(beforeId !== undefined && !Number.isInteger(beforeId)) ||
			(archiveId !== undefined && !Number.isInteger(archiveId)) ||
			!Number.isInteger(count) ||
			count < 1
		)
			throw bad("before, limit and archive must be whole numbers.");
		if (archiveId !== undefined)
			return json(await this.#archived(room.key, archiveId, beforeId, count));
		const page = await log.page(room.key, beforeId, count);
		// The cards stand among the messages by the time they opened; a page that has older
		// messages leaves the cards before its first one to the older page, and a conversation
		// started over leaves the archived one's cards to it.
		const first = page.messages[0];
		const { reads, nameOf } = this.#options;
		const self = admission.visitor.principal.id;
		const cursor = await reads?.cursorOf(room.key, self);
		return json({
			...page,
			messages: withExpiredFiles(
				page.messages.map((one) => this.#options.surface.delivery.shown(one)),
				this.#options.files,
			),
			cards: await cards.during(room.key, {
				...(first && (page.more || isStartOver(first))
					? { from: first.at }
					: {}),
				...(beforeId === undefined ? {} : { before: beforeId }),
			}),
			...(reads && nameOf
				? { reads: await readsOf(reads, room.key, self, nameOf) }
				: {}),
			...(cursor === undefined ? {} : { cursor }),
		} satisfies MessagesView);
	}

	/**
	 * A page of the conversation a start-over line of the room ended, read only: its messages and
	 * the cards that opened within it. A line that is not one of the room's start-overs names none.
	 */
	async #archived(
		room: ChannelKey,
		until: number,
		before: number | undefined,
		count: number,
	): Promise<MessagesView> {
		const { log, cards } = this.#options;
		const line = await log.get(room, until);
		if (!line || !isStartOver(line)) throw notFound();
		const page = await log.page(room, before, count, until);
		const first = page.messages[0];
		const previous = page.more ? undefined : await log.startOver(room, until);
		const from = page.more
			? first?.at
			: previous === undefined
				? undefined
				: (await log.get(room, previous))?.at;
		return {
			...page,
			messages: withExpiredFiles(page.messages, this.#options.files),
			cards: await cards.during(room, {
				...(from === undefined ? {} : { from }),
				before: before ?? until,
			}),
		};
	}
}
