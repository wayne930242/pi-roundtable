import {
	type ChannelKey,
	channelKey,
	type InterimMessage,
	type SurfaceThreads,
} from "pi-roundtable";
import type { RoomMessage } from "../api-types.ts";
import type { NewRoomMessage } from "./room-log.ts";
import type { WebThreads } from "./threads.ts";

/** The name a post shows when its sender names none. */
const ASSISTANT = "Assistant";
/** Discord's small-print marker, which the notices of the host carry. */
const NOTICE = /^-# /;

export interface AppSurfaceThreadsOptions {
	/** The key prefix of the rooms, such as `app`. */
	surface: string;
	threads: Pick<WebThreads, "open" | "close">;
	/** Stores a message of a room and shows it to every open socket. */
	publish(row: NewRoomMessage): Promise<RoomMessage>;
	/** Changes a stored message's text and shows the change to every open socket. */
	edit(room: ChannelKey, id: number, text: string): Promise<void>;
	/** Tells the sockets the room list differs. */
	changed(): void;
	/** Whether the room can host a thread: an agent's or group's room that exists, not a thread. */
	canHost(parent: ChannelKey): Promise<boolean>;
}

/** A thread's title as the label of a Markdown link, which cannot hold brackets. */
const labelOf = (title: string): string =>
	title.replace(/\[/g, "(").replace(/]/g, ")");

/**
 * The app's dispatch threads as a surface hosts them: a thread is a read-only room beside the
 * room that started the dispatch, one start line there that links to it, and the dispatch's
 * posts, cards and report inside. Closing ends the thread; the room stays readable.
 */
export class AppSurfaceThreads implements SurfaceThreads {
	readonly #options: AppSurfaceThreadsOptions;

	constructor(options: AppSurfaceThreadsOptions) {
		this.#options = options;
	}

	async open(
		parent: ChannelKey,
		name: string,
		line: (mention?: string) => string,
	): Promise<{ id: string; mention: string } | undefined> {
		const { surface, threads, publish, edit, changed, canHost } = this.#options;
		if (!(await canHost(parent))) return undefined;
		const start = await publish({
			room: parent,
			kind: "system",
			author: ASSISTANT,
			text: line(),
		});
		const thread = await threads.open(parent, name);
		const mention = `[${labelOf(thread.title)}](${channelKey(surface, thread.id)})`;
		// The start line links the thread once it exists; the thread stands even if the edit fails.
		await edit(parent, start.id, line(mention)).catch(() => undefined);
		changed();
		return { id: thread.id, mention };
	}

	async post(thread: string, text: string): Promise<void> {
		const notice = NOTICE.test(text);
		await this.#options.publish({
			room: channelKey(this.#options.surface, thread),
			kind: notice ? "system" : "agent",
			author: ASSISTANT,
			text: notice ? text.replace(NOTICE, "") : text,
		});
	}

	async send(thread: string, text: string): Promise<InterimMessage> {
		const room = channelKey(this.#options.surface, thread);
		const message = await this.#options.publish({
			room,
			kind: "agent",
			author: ASSISTANT,
			text,
		});
		return { edit: (change) => this.#options.edit(room, message.id, change) };
	}

	async close(thread: string): Promise<void> {
		await this.#options.threads.close(thread);
		this.#options.changed();
	}
}
