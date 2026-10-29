import {
	type AttachmentContent,
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
	roomOf,
	type TurnProgress,
} from "pi-roundtable";
import type { RoomFile, RoomMessage } from "../api-types.ts";
import type { OwnerDesk } from "./desk.ts";
import { type FileBinding, type FileDir, typeByName } from "./files.ts";
import type { NewRoomMessage, RoomLog } from "./room-log.ts";
import type { AppSocket, Audience, Sockets } from "./sockets.ts";
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
	/** Who has a room's frames: the owners' sockets for an agent room, a host room's readers for a host room. */
	audienceOf(room: string): Audience;
	/** Whether the room is a host's (its frames are the `host_*` ones). */
	isHostRoom(room: string): boolean;
	/** What binds a file an agent attaches in a host room, so its readers are served it. */
	fileBinding?(room: string): FileBinding | undefined;
	/** Tells the sockets the room list differs, once changes settle. */
	changed(): void;
	/**
	 * Hears of an agent's reply in a room that no message from a page started, such as a
	 * schedule's, a report's or a late answer's. Never throws into the turn.
	 */
	unprompted?(room: ChannelKey, author: string, text: string): void;
	/** Called when a room's activity changes, so the presence table can follow. */
	activity?(): void;
	/** What was said in a host room since the assistant last posted; the host rooms' reader. */
	channelContext?: ChatSurface["channelContext"];
	/** The clock, in milliseconds; default `Date.now`. */
	now?: () => number;
	logger: Logger;
}

/**
 * A turn that starts this soon after a page's message in its room is that message's. The core
 * does not tell a surface what started a turn (`startTyping` carries only the channel), so this
 * is a heuristic: a schedule's turn within the window of a page message in the same room reads as
 * asked, and a slow reply is still taken for asked since its typing began in time.
 */
const ASKED_WINDOW_MS = 30_000;

/** The counts and marks behind a room's `activity`. */
interface Activity {
	typing: number;
	stoppable: number;
	/** The tool calls that have started and not ended. */
	tools: Set<string>;
	/** The latest author of an interim text or reply: the member speaking in a group round. */
	agent?: string;
	/** How the turn's last reply went, once it posted one. */
	outcome?: "done" | "failed";
}

/** What a room's `activity` says apart from its counts. */
export interface RoomActivity {
	typing: boolean;
	stoppable: boolean;
	phase?: "thinking" | "working";
	agent?: string;
}

/**
 * The owner app's rooms as a chat surface: what the host shows in a room reaches the sockets that
 * may have it (the owners' for an agent room) as a frame, and what a room says is stored in the room log. The agent team runs
 * in the rooms (`agentRooms`) as it runs in its Discord channels, but each room is a
 * conversation of its own. A reply arrives whole, in Markdown, with its files stored, and an
 * agent's interim text is shown live until the final reply replaces it.
 */
export class AppSurface implements ChatSurface {
	readonly surface: string;
	readonly agentRooms = true;
	readonly supportsFiles = true;
	readonly formatting = APP_FORMATTING;
	/** The turn takes an upload up to the most the app lets a person upload. */
	readonly maxAttachmentBytes: number;
	/** Present on a surface with host rooms: what was said in one since the assistant last posted. */
	channelContext?: ChatSurface["channelContext"];
	readonly threads: AppSurfaceThreads;
	readonly #options: AppSurfaceOptions;
	readonly #activity = new Map<ChannelKey, Activity>();
	/** When a page last sent a message to each room. */
	readonly #askedAt = new Map<ChannelKey, number>();
	/** The turns running in each room that a page's message started. */
	readonly #asked = new Map<ChannelKey, number>();
	#deliver: ((message: InboundMessage) => void) | undefined;

	constructor(options: AppSurfaceOptions) {
		this.surface = options.surface;
		this.maxAttachmentBytes = options.uploads.maxBytes;
		this.#options = options;
		if (options.channelContext) this.channelContext = options.channelContext;
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
		this.#noteAsked(message.channel);
		this.#deliver(message);
	}

	/** Whether the host started the surface, so messages are taken. */
	get started(): boolean {
		return this.#deliver !== undefined;
	}

	/** Stores a message of a room and shows it to the sockets that may have the room, except `except`. */
	async publish(row: NewRoomMessage, except?: AppSocket): Promise<RoomMessage> {
		const message = await this.#options.log.append(row);
		this.#options.sockets.deliver(
			this.#options.isHostRoom(row.room)
				? { type: "host_message", room: row.room, message }
				: { type: "message", room: row.room, message },
			this.#options.audienceOf(row.room),
			except,
		);
		return message;
	}

	/** Changes the text of a stored message and shows the change to the sockets that may have the room. */
	async edit(room: ChannelKey, id: number, text: string): Promise<void> {
		const message = await this.#options.log.edit(room, id, text);
		if (!message) return;
		this.#options.sockets.deliver(
			this.#options.isHostRoom(room)
				? { type: "host_edited", room: message.room, message }
				: { type: "edited", room: message.room, message },
			this.#options.audienceOf(room),
		);
	}

	/** Whether a turn works in the room and whether Stop applies, as `activity` frames say. */
	activityOf(room: ChannelKey): RoomActivity {
		const found = this.#activity.get(room);
		const typing = (found?.typing ?? 0) > 0;
		return {
			typing,
			stoppable: (found?.stoppable ?? 0) > 0,
			...(typing ? { phase: found?.tools.size ? "working" : "thinking" } : {}),
			...(typing && found?.agent ? { agent: found.agent } : {}),
		};
	}

	/** The agents with a turn working in an app room now: a room's own agent, or a group's speaker. */
	workingAgents(): Set<string> {
		const names = new Set<string>();
		for (const [room, entry] of this.#activity) {
			if (entry.typing === 0) continue;
			const named = roomOf(room, [this.surface]);
			if (named?.kind === "agent") names.add(named.name);
			if (entry.agent) names.add(entry.agent);
		}
		return names;
	}

	#entry(room: ChannelKey): Activity {
		const found = this.#activity.get(room);
		if (found) return found;
		const entry: Activity = { typing: 0, stoppable: 0, tools: new Set() };
		this.#activity.set(room, entry);
		return entry;
	}

	#count(room: ChannelKey, key: "typing" | "stoppable"): () => void {
		const entry = this.#entry(room);
		// A new turn forgets how the last one ended.
		if (key === "typing" && entry.typing === 0) {
			delete entry.outcome;
			delete entry.agent;
		}
		entry[key] += 1;
		this.#announce(room);
		let on = true;
		return () => {
			if (!on) return;
			on = false;
			entry[key] -= 1;
			const idle = entry.typing === 0;
			if (idle) entry.tools.clear();
			// The outcome rides the frame on which typing turns false, and is read before the entry goes.
			const outcome = key === "typing" && idle ? entry.outcome : undefined;
			if (idle && entry.stoppable === 0) this.#activity.delete(room);
			this.#announce(room, outcome);
		};
	}

	#announce(room: ChannelKey, outcome?: "done" | "failed"): void {
		this.#options.sockets.deliver(
			{
				type: "activity",
				room,
				...this.activityOf(room),
				...(outcome ? { outcome } : {}),
			},
			this.#options.audienceOf(room),
		);
		this.#options.activity?.();
	}

	/** Names the member speaking in the room; a changed speaker is shown at once. */
	#speaks(room: ChannelKey, agent: string | undefined): void {
		const entry = this.#activity.get(room);
		if (!entry || entry.typing === 0 || !agent || entry.agent === agent) return;
		entry.agent = agent;
		this.#announce(room);
	}

	startTyping(channel: ChannelKey): () => void {
		const stop = this.#count(channel, "typing");
		const askedAt = this.#askedAt.get(channel);
		if (askedAt === undefined) return stop;
		if (this.#now() - askedAt > ASKED_WINDOW_MS) {
			this.#askedAt.delete(channel);
			return stop;
		}
		this.#asked.set(channel, (this.#asked.get(channel) ?? 0) + 1);
		let on = true;
		return () => {
			stop();
			if (!on) return;
			on = false;
			const left = (this.#asked.get(channel) ?? 1) - 1;
			if (left > 0) this.#asked.set(channel, left);
			else this.#asked.delete(channel);
		};
	}

	/** Notes a page's message, and forgets the rooms whose last message is past the window. */
	#noteAsked(channel: ChannelKey): void {
		const now = this.#now();
		for (const [room, at] of this.#askedAt)
			if (now - at > ASKED_WINDOW_MS) this.#askedAt.delete(room);
		this.#askedAt.set(channel, now);
	}

	#now(): number {
		return (this.#options.now ?? Date.now)();
	}

	showStop(channel: ChannelKey): () => void {
		return this.#count(channel, "stoppable");
	}

	async sendReply(channel: ChannelKey, reply: OutboundReply): Promise<void> {
		this.#speaks(channel, reply.author?.agent);
		const entry = this.#activity.get(channel);
		if (entry) entry.outcome = reply.failed ? "failed" : "done";
		const files: RoomFile[] = (reply.files ?? []).map((file) =>
			this.#options.files.put(
				file.name,
				typeByName(file.name),
				file.data,
				undefined,
				this.#options.isHostRoom(channel)
					? this.#options.fileBinding?.(channel)
					: undefined,
			),
		);
		await this.publish({
			room: channel,
			kind: "agent",
			...(reply.author?.agent ? { agent: reply.author.agent } : {}),
			author: reply.author?.name ?? ASSISTANT,
			text: reply.chunks.join("\n"),
			files,
		});
		if ((this.#asked.get(channel) ?? 0) === 0) {
			try {
				this.#options.unprompted?.(
					channel,
					reply.author?.name ?? ASSISTANT,
					reply.chunks.join("\n"),
				);
			} catch (error) {
				this.#options.logger.warn(
					{ room: channel, err: error },
					"a reply's listener failed",
				);
			}
		}
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
				this.#speaks(channel, as?.agent);
				const live = crypto.randomUUID();
				const show = (current: string) =>
					this.#options.sockets.deliver(
						{
							type: this.#options.isHostRoom(channel)
								? "host_message"
								: "message",
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
						},
						this.#options.audienceOf(channel),
					);
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
	): Promise<AttachmentContent> {
		return this.#options.uploads.read(ref);
	}

	progress(channel: ChannelKey, event: TurnProgress): void {
		this.#toolEvent(channel, event);
		// Only the sockets showing the room get its progress, and only those that may have the room.
		const audience = this.#options.audienceOf(channel);
		this.#options.sockets.deliver(
			{ type: "progress", room: channel, event },
			"owners" in audience
				? { owners: true, focus: channel }
				: "room" in audience
					? { room: audience.room, focus: true }
					: audience,
		);
	}

	/** A tool call that starts moves the room to `working`; the last one that ends moves it back. */
	#toolEvent(channel: ChannelKey, event: TurnProgress): void {
		const entry = this.#activity.get(channel);
		if (!entry || entry.typing === 0) return;
		if (event.type === "tool_start") {
			const was = entry.tools.size;
			entry.tools.add(event.id);
			if (was === 0) this.#announce(channel);
		} else if (event.type === "tool_end") {
			if (entry.tools.delete(event.id) && entry.tools.size === 0)
				this.#announce(channel);
		}
	}
}
