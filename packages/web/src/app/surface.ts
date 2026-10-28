import {
	type AttachmentRef,
	type ChannelKey,
	type ChatSurface,
	type InboundMessage,
	type InterimPosts,
	type Logger,
	type OutboundReply,
	PluginError,
	type PostAuthor,
	type PromptScope,
	type Prompts,
	type TurnProgress,
} from "pi-roundtable";
import type { RoomFile, RoomMessage } from "../api-types.ts";
import type { OwnerDesk } from "./desk.ts";
import { type FileDir, typeByName } from "./files.ts";
import type { NewRoomMessage, RoomLog } from "./room-log.ts";
import type { AppSocket, Sockets } from "./sockets.ts";
import { AppSurfaceThreads } from "./surface-threads.ts";
import type { WebThreads } from "./threads.ts";
import type { Uploads } from "./uploads.ts";

/**
 * What the model is told about the app's rendering, as the surface's `formatting`. English: it is
 * model-facing text, not a message-catalog string.
 */
const APP_FORMATTING =
	"Reply formatting (web app): Markdown renders, including tables, headings, lists, quotes, links, inline code and fenced code blocks. Raw HTML does not render. Files you attach appear under your message.";

/** The name a reply shows when its sender names none. */
const ASSISTANT = "Assistant";

export interface AppSurfaceOptions {
	/** The key prefix of the rooms, such as `app`. */
	surface: string;
	sockets: Sockets;
	desk: OwnerDesk;
	log: RoomLog;
	/** Where the files agents attach to replies are kept. */
	files: FileDir;
	uploads: Uploads;
	threads: Pick<WebThreads, "open" | "close">;
	/** Whether a room can host a thread: an agent's or group's room that exists. */
	canHost(parent: ChannelKey): Promise<boolean>;
	/** Tells the sockets the room list differs, once changes settle. */
	changed(): void;
	logger: Logger;
}

/** The counts behind a room's `activity`. */
interface Activity {
	typing: number;
	stoppable: number;
}

/**
 * The owner app's rooms as a chat surface: what the host shows in a room reaches every socket of
 * every owner as a frame, and what a room says is stored in the room log. The agent team runs
 * in the rooms (`agentRooms`) as it runs in its Discord channels, but each room is a
 * conversation of its own. A reply arrives whole, in Markdown, with its files stored, and an
 * agent's interim text is shown live until the final reply replaces it.
 */
export class AppSurface implements ChatSurface {
	readonly surface: string;
	readonly agentRooms = true;
	readonly supportsFiles = true;
	readonly formatting = APP_FORMATTING;
	readonly threads: AppSurfaceThreads;
	readonly #options: AppSurfaceOptions;
	readonly #activity = new Map<ChannelKey, Activity>();
	#deliver: ((message: InboundMessage) => void) | undefined;

	constructor(options: AppSurfaceOptions) {
		this.surface = options.surface;
		this.#options = options;
		this.threads = new AppSurfaceThreads({
			surface: options.surface,
			threads: options.threads,
			publish: (row) => this.publish(row),
			edit: (room, id, text) => this.edit(room, id, text),
			changed: options.changed,
			canHost: options.canHost,
		});
	}

	async start(deliver: (message: InboundMessage) => void): Promise<void> {
		this.#deliver = deliver;
	}

	async stop(): Promise<void> {
		this.#deliver = undefined;
	}

	/** Hands a message to the host; throws before the host started the surface. */
	deliver(message: InboundMessage): void {
		if (!this.#deliver)
			throw new PluginError(
				"the web app surface has not started; messages are taken once the host runs",
			);
		this.#deliver(message);
	}

	/** Whether the host started the surface, so messages are taken. */
	get started(): boolean {
		return this.#deliver !== undefined;
	}

	/** Stores a message of a room and shows it to every open socket, except `except`. */
	async publish(row: NewRoomMessage, except?: AppSocket): Promise<RoomMessage> {
		const message = await this.#options.log.append(row);
		this.#options.sockets.broadcast(
			{ type: "message", room: row.room, message },
			undefined,
			except,
		);
		return message;
	}

	/** Changes the text of a stored message and shows the change to every open socket. */
	async edit(room: ChannelKey, id: number, text: string): Promise<void> {
		const message = await this.#options.log.edit(id, text);
		if (!message) return;
		this.#options.sockets.broadcast({ type: "edited", room, message });
	}

	/** Whether a turn works in the room and whether Stop applies, as `activity` frames say. */
	activityOf(room: ChannelKey): { typing: boolean; stoppable: boolean } {
		const found = this.#activity.get(room);
		return {
			typing: (found?.typing ?? 0) > 0,
			stoppable: (found?.stoppable ?? 0) > 0,
		};
	}

	#count(room: ChannelKey, key: keyof Activity): () => void {
		const entry = this.#activity.get(room) ?? { typing: 0, stoppable: 0 };
		this.#activity.set(room, entry);
		entry[key] += 1;
		this.#announce(room);
		let on = true;
		return () => {
			if (!on) return;
			on = false;
			entry[key] -= 1;
			if (entry.typing === 0 && entry.stoppable === 0)
				this.#activity.delete(room);
			this.#announce(room);
		};
	}

	#announce(room: ChannelKey): void {
		this.#options.sockets.broadcast({
			type: "activity",
			room,
			...this.activityOf(room),
		});
	}

	startTyping(channel: ChannelKey): () => void {
		return this.#count(channel, "typing");
	}

	showStop(channel: ChannelKey): () => void {
		return this.#count(channel, "stoppable");
	}

	async sendReply(channel: ChannelKey, reply: OutboundReply): Promise<void> {
		const files: RoomFile[] = (reply.files ?? []).map((file) =>
			this.#options.files.put(file.name, typeByName(file.name), file.data),
		);
		await this.publish({
			room: channel,
			kind: "agent",
			...(reply.author?.agent ? { agent: reply.author.agent } : {}),
			author: reply.author?.name ?? ASSISTANT,
			text: reply.chunks.join("\n"),
			files,
		});
	}

	async markFresh(channel: ChannelKey): Promise<void> {
		await this.publish({
			room: channel,
			kind: "system",
			author: ASSISTANT,
			text: "Conversation started over",
		});
	}

	prompts(channel: ChannelKey, scope?: PromptScope): Prompts | undefined {
		return this.#options.desk.prompts(channel, scope);
	}

	interim(channel: ChannelKey, as?: PostAuthor): InterimPosts {
		return {
			post: async (text) => {
				const live = crypto.randomUUID();
				const show = (current: string) =>
					this.#options.sockets.broadcast({
						type: "message",
						room: channel,
						message: {
							id: 0,
							room: channel,
							kind: "agent",
							...(as?.agent ? { agent: as.agent } : {}),
							author: as?.name ?? ASSISTANT,
							text: current,
							files: [],
							at: new Date().toISOString(),
							live,
						},
					});
				show(text);
				return {
					edit: async (edited) => {
						show(edited);
					},
				};
			},
		};
	}

	readAttachment(
		_channel: ChannelKey,
		ref: AttachmentRef,
	): Promise<Uint8Array> {
		return this.#options.uploads.read(ref);
	}

	progress(channel: ChannelKey, event: TurnProgress): void {
		this.#options.sockets.broadcast(
			{ type: "progress", room: channel, event },
			(connection) => connection.focus === channel,
		);
	}
}
