import type { OutboundReply } from "../domain/conversation.ts";
import type { InterimPosts } from "../domain/interim.ts";
import type { OwnerPrompts } from "../domain/owner-prompts.ts";
import type { TurnProgress } from "../domain/progress.ts";
import { PluginError } from "../errors.ts";
import type { ChannelKey } from "../sessions.ts";
import type { Speaker } from "../speakers.ts";
import type { InboundMessage } from "./channels.ts";

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
	/** Adds or removes the bot's reaction on a message; failures are logged, never thrown. */
	react?(channel: ChannelKey, messageId: string, emoji: string): Promise<void>;
	unreact?(
		channel: ChannelKey,
		messageId: string,
		emoji: string,
	): Promise<void>;
	/**
	 * How the owner approves held actions or answers ask_user in a running turn; undefined, or
	 * absent, = the action is held until the owner's next message.
	 */
	prompts?(channel: ChannelKey, speaker?: Speaker): OwnerPrompts | undefined;
	/**
	 * Where a running turn posts the text it writes before its final answer: ordinary messages it
	 * may edit in place. Absent, or undefined, = only the final reply is posted.
	 */
	interim?(channel: ChannelKey): InterimPosts | undefined;
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
	/** The owner's prompts in the channel; undefined when its surface has none. */
	prompts(channel: ChannelKey, speaker?: Speaker): OwnerPrompts | undefined;
	/** The channel's interim posts; undefined when its surface has none. */
	interim(channel: ChannelKey): InterimPosts | undefined;
	/** Shows a running turn's progress; a no-op when no surface serves the channel or its surface shows none. */
	progress(channel: ChannelKey, event: TurnProgress): Promise<void>;
}
