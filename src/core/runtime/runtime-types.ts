import type {
	AgentSession,
	AgentSessionEvent,
	ExtensionFactory,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessions, LoadedSkill } from "../contract/runtime.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import type { InterimTextMode } from "../domain/interim.ts";
import type { TurnConversation } from "../domain/ports.ts";
import type { Principal } from "../identity/principal-store.ts";
import type { OwnerIdentity } from "../identity.ts";
import type { PromptScope, Prompts } from "../interactions/prompts.ts";
import type { Logger } from "../log.ts";
import type { ThinkingLevel, ThinkingPicker } from "../models.ts";
import type { LinkedSessions } from "../plugin.ts";
import {
	planOrder,
	type SessionContext,
	type SessionConversation,
	type SessionPlan,
	type SessionTool,
} from "../sessions.ts";
import type { ToolTiers } from "../tool-tiers.ts";
import type { MemoryDraws } from "./extensions/private-memory.ts";
import type { PendingConfirmationStore } from "./pending-confirmation-store.ts";

export type TurnMessage = Extract<
	AgentSessionEvent,
	{ type: "message_end" }
>["message"];
export type CompactionEnd = Extract<
	AgentSessionEvent,
	{ type: "compaction_end" }
>;
export const TRANSCRIPT_ENTRY_CHARS = 1000;

export interface PiAgentRuntimeOptions {
	/**
	 * The primary owner, by their principal id: their conversations' prompts and tool results name
	 * them as configured, and the host's own turns address them.
	 */
	owner: OwnerIdentity & { id: string };
	/**
	 * The host's record of a conversation, read at every turn that names none, so a record changed
	 * while its session is open counts, and when its transcript is read; without it, or without a
	 * record, the conversation is as its open session or its history was made, else shared.
	 */
	conversationOf?: (key: ChannelKey) => Promise<TurnConversation | undefined>;
	/** A principal's name and pronouns, which a private conversation's tool descriptions use. */
	principalOf?: (id: string) => Promise<Principal | undefined>;
	agentDir: string;
	/** Shared by the host's sessions, so logins refresh in one place. */
	modelRuntime: ModelRuntime;
	dataDir: string;
	model: { provider: string; id: string };
	/** A new session's level until its first turn; each turn then runs at a level of its own. */
	thinking: ThinkingLevel;
	/** Picks the level of the assistant's turns and of agents whose thinking is `auto`. */
	effort: ThinkingPicker;
	/** Held actions survive a restart here, so a confirmation after one still runs. */
	confirmations: Pick<PendingConfirmationStore, "load" | "save">;
	logger: Logger;
	/**
	 * The plugins' linked session parts: hold rules, Pi packages, and the extensions placed by
	 * phase around the core's own. Read once the host has linked them, from the preflight on.
	 * A changed snapshot revision rebuilds each session on its next turn, keeping its history.
	 */
	sessions: () => LinkedSessions;
	/** The agent server's sessions: their shared workspace, model, and skills. */
	agents?: AgentSessions;
	/**
	 * The prompts of a channel for an interactive turn's scope, made from its speaker and its
	 * conversation's visibility; undefined for a channel that cannot show them. Without it every
	 * held action waits for a message that approves it.
	 */
	prompts?: (channel: ChannelKey, scope?: PromptScope) => Prompts | undefined;
	/** The lowest tier that may use each tool; the default names the core's tools and leaves the rest to the owner. */
	toolTiers?: ToolTiers;
	/** A run that takes longer, not counting time spent waiting on the owner's cards, is aborted and reported as failed. */
	turnTimeoutMs?: number;
	/**
	 * Whether a turn given a place for interim posts shows the text it writes before its final
	 * answer as it goes; default "on". "off" posts only the final reply.
	 */
	interimText?: InterimTextMode;
	/** An intermediate text this long or longer is posted as an ordinary message; default 400. */
	interimPrimaryChars?: number;
	/** How long a new session waits for its MCP tools to register. */
	mcpConnectTimeoutMs?: number;
	/**
	 * Why an agent may not switch to a model on claude-bridge, read at its turn: the host keeps
	 * several people's memory in its shared conversations. Undefined when it may.
	 */
	bridgeRefusal?: () => string | undefined;
}

export type { AgentSessions, LoadedSkill };

export const skillsKey = (skills: readonly LoadedSkill[]) =>
	JSON.stringify(skills);
export const revisionsKey = (plan: SessionPlan) =>
	JSON.stringify(planOrder(plan).map((tool) => tool.snapshot().revision));

/** The core's own extensions of one session, which the plan's contributions surround. */
export interface CoreExtensions {
	readAttachment: ExtensionFactory;
	confirmationGate: ExtensionFactory;
	askUser: ExtensionFactory;
	selfCompactGuard: ExtensionFactory;
	privateMemory: ExtensionFactory;
	activeTools: ExtensionFactory;
}

/**
 * A session's extensions in load order: the tools phase, the core's attachment, gate, ask-user,
 * and compact guard, the compactor, the MCP phase, the memory projection, so each request is
 * projected after every other extension changed it, and active-tools last, so its
 * before_agent_start handler runs after every other extension's.
 */
export function sessionExtensions(
	plan: SessionPlan,
	session: SessionContext,
	core: CoreExtensions,
): { name: string; factory: ExtensionFactory }[] {
	const contributed = (tools: readonly SessionTool[]) =>
		tools.flatMap((tool) => {
			const factory = tool.snapshot().factory(session);
			return factory ? [{ name: tool.name, factory }] : [];
		});
	return [
		...contributed(plan.tools),
		{ name: "read-attachment", factory: core.readAttachment },
		{ name: "confirmation-gate", factory: core.confirmationGate },
		{ name: "ask-user", factory: core.askUser },
		{ name: "self-compact-guard", factory: core.selfCompactGuard },
		...contributed(plan.compaction ? [plan.compaction] : []),
		...contributed(plan.mcp),
		{ name: "private-memory", factory: core.privateMemory },
		{ name: "active-tools", factory: core.activeTools },
	];
}

export interface ChannelSession {
	session: AgentSession;
	/** Read by the active-tools extension at the start of every run. */
	tools: readonly string[];
	/** The session tools' revisions the session was built with, as revisionsKey. */
	revisions: string;
	/** The skills an agent session was built with, as skillsKey. */
	skills: string;
	/** Whom the session's conversation serves, fixed when it was built. */
	conversation: SessionConversation;
	/** Whom its tool descriptions address. */
	addressee: OwnerIdentity;
	/** Whose memory its turns read, as resolved when it was built; a worker beside it keeps the same. */
	memory: SessionContext["memory"];
	/** Its tool calls running now, which a task that reads the reader's memory marks as drawing on it. */
	draws: MemoryDraws;
}
