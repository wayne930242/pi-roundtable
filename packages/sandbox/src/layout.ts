import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ChannelKey } from "pi-roundtable";
import { HISTORY_FILE } from "./history.ts";

const digest = (text: string): string =>
	createHash("sha256").update(text).digest("hex");

/** Directory name of a channel's own workspace (`workspace: "channel"`, and a message with no guild). */
export function channelWorkspaceName(channel: ChannelKey): string {
	return digest(channel);
}
/** Directory name of a guild's shared workspace (`workspace: "server"`). */
export function guildWorkspaceName(surface: string, guild: string): string {
	return `guild-${digest(`guild\0${surface}:${guild}`)}`;
}
/** Directory name of a channel's own state directory, mounted at `/channel` in `"server"` mode. */
export function channelStateName(channel: ChannelKey): string {
	return `state-${digest(`state\0${channel}`)}`;
}

/** A channel's own workspace under `workspaceRoot`; memory, files and history live in it. */
export function channelWorkspaceDir(
	workspaceRoot: string,
	channel: ChannelKey,
): string {
	return join(workspaceRoot, channelWorkspaceName(channel));
}
/**
 * The workspace every sandbox channel of one guild shares in `workspace: "server"` mode, for the
 * guild `guild` of `surface` (`"discord"`). It holds memory notes and workspace files.
 */
export function guildWorkspaceDir(
	workspaceRoot: string,
	surface: string,
	guild: string,
): string {
	return join(workspaceRoot, guildWorkspaceName(surface, guild));
}
/**
 * One channel's state directory in `workspace: "server"` mode; its conversation history
 * (`historyFilePath`) lives there, and a turn sees only its own channel's.
 */
export function channelStateDir(
	workspaceRoot: string,
	channel: ChannelKey,
): string {
	return join(workspaceRoot, channelStateName(channel));
}
/** The history file inside a channel's state directory (or its workspace in `"channel"` mode). */
export function historyFilePath(directory: string): string {
	return join(directory, HISTORY_FILE);
}
