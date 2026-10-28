import type { OutboundReply, PostAuthor } from "../domain/conversation.ts";
import type { InterimMessage, InterimPosts } from "../domain/interim.ts";
import type { TurnProgress } from "../domain/progress.ts";
import { PluginError } from "../errors.ts";
import type { PromptScope, Prompts } from "../interactions/prompts.ts";
import type { ChannelKey } from "../sessions.ts";
import type { Speaker } from "../speakers.ts";
import type {
	AttachmentContent,
	AttachmentRef,
	InboundMessage,
} from "./channels.ts";

/**
 * Splits a channel key, `<surface>:<id>`, at its first colon: the surface names the chat network
 * that owns the channel, such as `discord`, and the id is that network's own, and may contain colons.
 * Throws PluginError for a key without a surface.
 */
export function parseChannelKey(key: ChannelKey): {
	surface: string;
	id: string;
} {
	const at = typeof key === "string" ? key.indexOf(":") : -1;
	if (at <= 0)
		throw new PluginError(
			`"${String(key)}" is not a channel key. A key is <surface>:<id>, such as discord:123.`,
		);
	return { surface: key.slice(0, at), id: key.slice(at + 1) };
}

/** The key of a channel on a surface; the inverse of `parseChannelKey`. */
export function channelKey(surface: string, id: string): ChannelKey {
	if (surface === "" || surface.includes(":"))
		throw new PluginError(
			`"${surface}" is not a surface name. A surface is a non-empty word without a colon, such as discord.`,
		);
	return `${surface}:${id}`;
}

/**
 * The threads a surface hosts for background dispatches (coding tasks, delegated tasks, messages
 * between agents): a place beside a channel where one dispatch posts its progress and report. A
 * thread's id is the surface's own and unique among its threads; the thread as a conversation
 * channel is `channelKey(surface, id)`.
 */
export interface SurfaceThreads {
	/**
	 * Posts the start line in `parent` and opens a thread from it. `line` gives the start line's
	 * text: called with no argument for the first post, and with the thread's `mention` once the
	 * thread exists, so a surface that can edit its post shows the link. Resolves to undefined when
	 * `parent` cannot host a thread, such as a direct message or a thread; rejects when the surface
	 * refuses. `mention` is how the thread is named in text, such as `<#id>` on Discord.
	 */
	open(
		parent: ChannelKey,
		name: string,
		line: (mention?: string) => string,
	): Promise<{ id: string; mention: string } | undefined>;
	/** Posts text in the thread. */
	post(thread: string, text: string): Promise<void>;
	/**
	 * Posts one message of at most 2000 characters and resolves to it, so it can be edited in
	 * place; without it a thread has no `interim` posts.
	 */
	send?(thread: string, text: string): Promise<InterimMessage>;
	/** Archives the thread, and locks it when the surface allows. */
	close(thread: string): Promise<void>;
}

/**
 * One chat network the host talks through. The host ships Discord's; a plugin may contribute
 * another with `surfaces`. A surface serves the channels whose key starts with its `surface`
 * prefix, and only those reach its methods.
 */
export interface ChatSurface {
	/** The key prefix of this surface's channels, such as "discord"; unique per host. */
	readonly surface: string;
	/** Explicit opt-in to delivering OutboundReply.files; absent or false refuses turn attachments. */
	readonly supportsFiles?: boolean;
	/**
	 * Serves a room for each agent and group of the agent team, `<surface>:agent.<name>` and
	 * `<surface>:group.<name>`: separate conversations from the agents' Discord channels, with
	 * their own session, held actions and group log, run by the same team. The team replies in a
	 * room through `sendReply` with `OutboundReply.author`. Absent or false = no rooms.
	 */
	readonly agentRooms?: boolean;
	/**
	 * Hosts dispatch threads: a background dispatch started in one of this surface's channels
	 * opens its thread here, and the thread is the conversation `<surface>:<id>`. Absent = the
	 * dispatch posts in the channel as before.
	 */
	readonly threads?: SurfaceThreads;
	/**
	 * Short English guidance on how a reply renders here, such as "no Markdown tables", which the
	 * runtime appends to the system prompt of every turn that replies on this surface, after the
	 * persona. It is model-facing text, so it is not a message-catalog string. Absent = nothing is
	 * appended; a turn whose channel has no surface gets none either.
	 */
	readonly formatting?: string;
	/**
	 * Connects and delivers every incoming message; the host passes its conversation router. A
	 * message whose channel key has another prefix is logged and dropped.
	 */
	start(deliver: (message: InboundMessage) => void): Promise<void>;
	/** Runs when the host stops, after the services started later have stopped. */
	stop?(): Promise<void>;
	sendReply(channel: ChannelKey, reply: OutboundReply): Promise<void>;
	/** Shows a typing indicator until the returned function is called; absent = none shown. */
	startTyping?(channel: ChannelKey): () => void;
	/**
	 * Shows the owner a stop control until the returned function is called; it calls
	 * `conversations.stop(channel)` when used. Absent = none shown.
	 */
	showStop?(channel: ChannelKey): () => void;
	/**
	 * Marks in the channel, publicly, that its conversation just started over, so what a reader of
	 * the channel's history would take for the conversation's context ends there; called after the
	 * claim's `startFresh` succeeded. A rejection is logged and the restart still counts. Absent =
	 * nothing is posted.
	 */
	markFresh?(channel: ChannelKey): Promise<void>;
	/** Adds or removes the bot's reaction on a message; failures are logged, never thrown. */
	react?(channel: ChannelKey, messageId: string, emoji: string): Promise<void>;
	unreact?(
		channel: ChannelKey,
		messageId: string,
		emoji: string,
	): Promise<void>;
	/**
	 * How those the scope names approve held actions or answer ask_user in a running turn: the
	 * scope's speaker, and in a shared conversation the owners; see `Prompts` and `PromptScope`.
	 * Without a scope the prompts are the owners'. Undefined, or absent, = the action is held
	 * until a message approves it.
	 */
	prompts?(channel: ChannelKey, scope?: PromptScope): Prompts | undefined;
	/**
	 * Where a running turn posts the text it writes before its final answer: ordinary messages it
	 * may edit in place. `as` names who speaks when an agent of the team does, as `author` does in
	 * `sendReply`. Absent, or undefined, = only the final reply is posted.
	 */
	interim?(channel: ChannelKey, as?: PostAuthor): InterimPosts | undefined;
	/**
	 * The content of an attachment this surface made, such as a file the owner uploaded to a room:
	 * its bytes, or, for a file too large to hold in memory, `{ path }` of a file on the host or a
	 * stream, which the core stores without buffering the whole. A ref of a message on this
	 * surface is read here and never fetched over the network; a rejection fails that file. Absent
	 * = the refs of its messages are downloaded from their URLs.
	 */
	readAttachment?(
		channel: ChannelKey,
		ref: AttachmentRef,
	): Promise<AttachmentContent>;
	/**
	 * The most bytes of one attachment a turn takes from this surface, for a ref, a file, a stream
	 * or a download alike; default 25 MiB (`MAX_ATTACHMENT_BYTES`), which Discord keeps. A larger
	 * file is refused as `larger than <n> MB`; a smaller value than the default is allowed.
	 * An image over 25 MiB is still not shown to the model, and a text or PDF file over 25 MiB is
	 * not read by `read_attachment`: both stay in the conversation's store, named in the turn's
	 * `## Attachments` block, for tools that take files.
	 */
	readonly maxAttachmentBytes?: number;
	/**
	 * Shows what a running turn writes and which tools it runs, as it goes, such as a live preview
	 * in a web chat. Called between the turn's start and its reply; a rejection is logged and the
	 * turn goes on. Absent = the surface shows only the final reply.
	 */
	progress?(channel: ChannelKey, event: TurnProgress): Promise<void> | void;
}

/**
 * Every contributed surface, chosen by the prefix of a channel's key. Calls during setup throw
 * NotLinkedError, because the surfaces are collected once every plugin is set up.
 */
export interface SurfacePort {
	/** The surface that serves the channel's prefix; undefined when none does. */
	of(channel: ChannelKey): ChatSurface | undefined;
	/** Throws PluginError naming the prefix when no surface serves it. */
	sendReply(channel: ChannelKey, reply: OutboundReply): Promise<void>;
	/** A no-op when no surface serves the channel or its surface shows none. */
	startTyping(channel: ChannelKey): () => void;
	/** A no-op when no surface serves the channel or its surface shows none. */
	showStop(channel: ChannelKey): () => void;
	react(channel: ChannelKey, messageId: string, emoji: string): Promise<void>;
	unreact(channel: ChannelKey, messageId: string, emoji: string): Promise<void>;
	/**
	 * The prompts in the channel for the scope's turn; undefined when its surface has none. A
	 * `Speaker`, the 0.8 form, is read as theirs in a shared conversation, with a deprecation
	 * warning, until 1.0.
	 */
	prompts(
		channel: ChannelKey,
		scope?: PromptScope | Speaker,
	): Prompts | undefined;
	/** The surfaces that serve agent rooms (`agentRooms: true`); read after link. */
	roomSurfaces(): readonly string[];
	/** The channel's interim posts, under `as` when given; undefined when its surface has none. */
	interim(channel: ChannelKey, as?: PostAuthor): InterimPosts | undefined;
	/**
	 * Shows a running turn's progress; a no-op when no surface serves the channel or its surface
	 * shows none. The host's port always has it; it is optional so a port written before 0.8 still
	 * type-checks, and a turn run over one without it shows no progress.
	 */
	progress?(channel: ChannelKey, event: TurnProgress): Promise<void>;
}
