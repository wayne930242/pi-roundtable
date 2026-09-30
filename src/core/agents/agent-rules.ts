import { AgentError } from "../domain/errors.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "../models.ts";

export const MAX_PROMPT_CHARS = 4_000;
export const MAX_AVATAR_PROMPT_CHARS = 1_000;
export const MIN_GROUP_MEMBERS = 2;
export const MAX_GROUP_MEMBERS = 6;

export type AgentStatus = "active" | "archived";

/** One agent of the agent server. `name` never changes; `displayName` is what Discord shows. */
export interface Agent {
	name: string;
	displayName: string;
	prompt: string;
	avatarPrompt: string;
	/** The drawn picture's content hash, when one exists. */
	avatarHash?: string;
	/** Its channel in the agent server; a seed agent has none until one is created. */
	channelId?: string;
	/** `<provider>/<id>`; unset follows the assistant's model. */
	model?: string;
	/** Unset follows the assistant's thinking level. */
	thinking?: ThinkingLevel;
	status: AgentStatus;
}

export interface AgentGroup {
	name: string;
	displayName: string;
	channelId: string;
	/** Agent names in the group's order. */
	members: string[];
	host: string;
	status: AgentStatus;
}

export interface AgentSeed {
	name: string;
	displayName: string;
	prompt: string;
	avatarPrompt: string;
	channelId?: string;
}

export interface GroupMessage {
	id: number;
	/** `owner` or an agent name. */
	author: string;
	authorName: string;
	text: string;
	at: Date;
}

export interface Backlog {
	messages: GroupMessage[];
	/** Waiting messages older than the ones carried. */
	skipped: number;
	/** The newest waiting id, which the cursor moves to once they are delivered. */
	lastId: number | undefined;
}

const RESERVED = /discord|clyde/i;

export function checkAgentName(name: string): void {
	if (!/^[a-z0-9-]{1,32}$/.test(name) || RESERVED.test(name))
		throw new AgentError(
			`"${name}" is not a usable name: use 1 to 32 lowercase letters, digits, and dashes, without "discord" or "clyde".`,
		);
}

export function checkDisplayName(displayName: string): void {
	const length = [...displayName.trim()].length;
	if (length < 1 || length > 32 || RESERVED.test(displayName))
		throw new AgentError(
			`"${displayName}" is not a usable display name: use 1 to 32 characters, without "discord" or "clyde".`,
		);
}

export function checkPrompt(prompt: string): void {
	if (!prompt.trim() || prompt.length > MAX_PROMPT_CHARS)
		throw new AgentError(
			`A prompt must have 1 to ${MAX_PROMPT_CHARS} characters; this one has ${prompt.length}.`,
		);
}

export function checkModelRef(model: string): void {
	if (!/^[\w.-]+\/[\w.:/-]+$/.test(model))
		throw new AgentError(
			`"${model}" is not a model: write it as <provider>/<model>, such as openai-codex/gpt-6-sol.`,
		);
}

export function checkThinking(level: string): asserts level is ThinkingLevel {
	if (!THINKING_LEVELS.includes(level as ThinkingLevel))
		throw new AgentError(
			`"${level}" is not a thinking level; use one of ${THINKING_LEVELS.join(", ")}.`,
		);
}

export function checkAvatarPrompt(prompt: string): void {
	if (!prompt.trim() || prompt.length > MAX_AVATAR_PROMPT_CHARS)
		throw new AgentError(
			`An avatar prompt must have 1 to ${MAX_AVATAR_PROMPT_CHARS} characters; this one has ${prompt.length}.`,
		);
}
