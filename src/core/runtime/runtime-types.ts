import type {
	AgentSession,
	AgentSessionEvent,
	ExtensionFactory,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { ChannelKey } from "../domain/conversation.ts";
import type { OwnerPrompts } from "../domain/owner-prompts.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import type { OwnerIdentity } from "../identity.ts";
import type { Logger } from "../log.ts";
import type {
	ThinkingLevel,
	ThinkingPicker,
	ThinkingSetting,
} from "../models.ts";
import type { LinkedSessions } from "../plugin.ts";
import {
	planOrder,
	type SessionContext,
	type SessionPlan,
	type SessionTool,
} from "../sessions.ts";
import type { Speaker } from "../speakers.ts";
import type { ToolTiers } from "../tool-tiers.ts";
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
	/** Who the conversations serve, as prompts and tool results name them. */
	owner: OwnerIdentity;
	agentDir: string;
	/** Shared with the party broker, so logins refresh in one place. */
	modelRuntime: ModelRuntime;
	dataDir: string;
	model: { provider: string; id: string };
	/** A new session's level until its first turn; each turn then runs at a level of its own. */
	thinking: ThinkingLevel;
	/** Picks the level of the assistant's turns and of agents whose thinking is `auto`. */
	effort: ThinkingPicker;
	persona: string;
	/** Held actions survive a restart here, so a confirmation after one still runs. */
	confirmations: Pick<PendingConfirmationStore, "load" | "save">;
	logger: Logger;
	/**
	 * The plugins' linked session parts: hold rules, Pi packages, and the extensions placed by
	 * phase around the core's own. Read once the host has linked them, from the preflight on.
	 * A changed snapshot revision rebuilds each session on its next turn, keeping its history.
	 */
	sessions: () => LinkedSessions;
	/** Tools startup refuses to run without, besides those the session tools require. */
	requiredTools: readonly string[];
	/** The agent server's sessions: their shared workspace, model, and skills. */
	agents?: AgentSessions;
	/**
	 * Cards the owner answers in a channel, for interactive turns; undefined for a channel that
	 * cannot show them. Without it every held action waits for his next message.
	 */
	prompts?: (
		channel: ChannelKey,
		speaker?: Speaker,
	) => OwnerPrompts | undefined;
	/** The lowest tier that may use each tool; the default names the core's tools and leaves the rest to the owner. */
	toolTiers?: ToolTiers;
	/** A run that takes longer, not counting time spent waiting on the owner's cards, is aborted and reported as failed. */
	turnTimeoutMs?: number;
	/** How long a new session waits for its MCP tools to register. */
	mcpConnectTimeoutMs?: number;
}

export interface AgentSessions {
	/** The shell's working directory, shared by every agent; writes outside it are held. */
	workDir: string;
	/**
	 * The skills the agent carries, read at the start of every run; a change rebuilds its
	 * sessions, keeping their history (repos-and-skills spec behavior 21).
	 */
	skills(name: string): readonly LoadedSkill[];
	/** The agent's model (`<provider>/<id>`) and thinking setting, read at the start of every run. */
	modelOf(name: string): { model: string; thinking: ThinkingSetting };
	/** The channel the scope's turns run in: the group's for a seat in one, else the agent's own. */
	turnChannel(scope: AgentTurnScope): ChannelKey;
}

/** A skill file a session loads; only its name and description enter the prompt. */
export interface LoadedSkill {
	name: string;
	description: string;
	file: string;
}

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
	profileTools: ExtensionFactory;
}

/**
 * A session's extensions in load order: the tools phase, the core's attachment, gate, ask-user,
 * and compact guard, the compactor, the MCP phase, and profile-tools last, so its
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
		{ name: "profile-tools", factory: core.profileTools },
	];
}

export interface ChannelSession {
	session: AgentSession;
	/** Read by the profile-tools extension at the start of every run. */
	tools: readonly string[];
	/** The session tools' revisions the session was built with, as revisionsKey. */
	revisions: string;
	/** The skills an agent session was built with, as skillsKey. */
	skills: string;
}
