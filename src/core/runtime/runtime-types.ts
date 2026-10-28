import type {
	AgentSession,
	AgentSessionEvent,
	ExtensionFactory,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { ImageDrawer } from "../contract/providers.ts";
import type { AgentSessions, LoadedSkill } from "../contract/runtime.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import type { InterimTextMode } from "../domain/interim.ts";
import type { TurnConversation } from "../domain/ports.ts";
import type { Principal } from "../identity/principal-store.ts";
import type { OwnerIdentity } from "../identity.ts";
import type { PromptScope, Prompts } from "../interactions/prompts.ts";
import type { Logger } from "../log.ts";
import type { EffortPolicy, ThinkingLevel, ThinkingPicker } from "../models.ts";
import type { Autonomy } from "../modes/autonomy.ts";
import type { ConversationModes } from "../modes/conversation-modes.ts";
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
import { scopedCalls } from "./tool-call-scope.ts";

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
	/** Chooses a turn's rule for the picker, or a fixed level; absent = the judge decides alike for every turn. */
	effortPolicy?: EffortPolicy;
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
	/**
	 * The formatting guidance of the chat surface that serves a channel, such as
	 * `ChatSurface.formatting`; undefined for a channel with no surface or no guidance. Read before
	 * each run for the channel the turn replies in, and appended to the system prompt after the
	 * persona.
	 */
	formatting?: (channel: ChannelKey) => string | undefined;
	/** The lowest tier that may use each tool; the default names the core's tools and leaves the rest to the owner. */
	toolTiers?: ToolTiers;
	/**
	 * A run that works longer, not counting time spent waiting on the owner's cards, asks the owner
	 * on a card whether to go on (see `turnTimeoutCardMs`), or, when it cannot show one, is aborted
	 * and reported as failed with the reason; default 10 minutes. Each message steered into the turn gives it this
	 * budget again from that moment, up to `turnMaxMs`.
	 */
	turnTimeoutMs?: number;
	/**
	 * The most one turn may work in all, however often it is steered, not counting time spent
	 * waiting on the owner's cards; default three times `turnTimeoutMs`. Once it is reached the turn
	 * takes no more steering (the message waits for the next turn) and asks or is aborted as on its
	 * timeout; the owner's Continue moves the cap to a full `turnTimeoutMs` from then.
	 */
	turnMaxMs?: number;
	/**
	 * How long the card a turn posts when it reaches `turnTimeoutMs` or `turnMaxMs` waits for the
	 * owner's Continue or Cancel, in wall time, while the turn keeps working; default 5 minutes. With
	 * no answer by then the turn is aborted. A turn that cannot show a card is aborted at once.
	 */
	turnTimeoutCardMs?: number;
	/**
	 * The conversations' modes, read at each turn: a turn in a long-running conversation goes on
	 * past its time limit without a card, up to `autonomy.longRunningMaxMs` of work. Without it no
	 * conversation is long-running.
	 */
	modes?: Pick<ConversationModes, "peek">;
	/** How far the modes reach; default `DEFAULT_AUTONOMY`. */
	autonomy?: Autonomy;
	/**
	 * How long a turn that was aborted, by its timeout or a stop, gets to end before its session is
	 * disposed of and the turn is reported failed; default 15 seconds. A model that ignores the
	 * abort would otherwise hold the turn, and the shutdown drain, for ever.
	 */
	turnAbortGraceMs?: number;
	/** Whether the host is shutting down: a turn or a task is then refused before it starts. */
	stopping?: () => boolean;
	/**
	 * Whether a turn given a place for interim posts shows the text it writes before its final
	 * answer as it goes; default "on". "off" posts only the final reply.
	 */
	interimText?: InterimTextMode;
	/** An intermediate text this long or longer is posted as an ordinary message; default 400. */
	interimPrimaryChars?: number;
	/** How long a new session waits for its MCP tools to register. */
	mcpConnectTimeoutMs?: number;
	/** The host's image provider, when one fills the slot; sessions then offer `generate_image`. */
	images?: ImageDrawer;
	/** Defaults to true: bridge shared turns refuse raw private exchanges inaccessible to the reader. */
	memory?: boolean;
}

export type { AgentSessions, LoadedSkill };

export const skillsKey = (skills: readonly LoadedSkill[]) =>
	JSON.stringify(skills);
export const revisionsKey = (plan: SessionPlan) =>
	JSON.stringify(planOrder(plan).map((tool) => tool.snapshot().revision));

/** The core's own extensions of one session, which the plan's contributions surround. */
export interface CoreExtensions {
	readAttachment: ExtensionFactory;
	/** `attach_file`, for a session with a workspace. */
	attachFile?: ExtensionFactory;
	/** `generate_image`, for a host with an image provider. */
	generateImage?: ExtensionFactory;
	confirmationGate: ExtensionFactory;
	askUser: ExtensionFactory;
	selfCompactGuard: ExtensionFactory;
	privateMemory: ExtensionFactory;
	/** The formatting guidance of the surface the turn replies on, appended after the persona. */
	surfaceFormatting: ExtensionFactory;
	activeTools: ExtensionFactory;
}

/**
 * A session's extensions in load order: the tools phase, the core's attachment, gate, ask-user,
 * and compact guard, the compactor, the MCP phase, the memory projection, so each request is
 * projected after every other extension changed it, the surface's formatting guidance, so it follows
 * the persona and everything appended before it, and active-tools last, so its
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
			return factory
				? [{ name: tool.name, factory: scopedCalls(factory) }]
				: [];
		});
	return [
		...contributed(plan.tools),
		{ name: "read-attachment", factory: core.readAttachment },
		...(core.attachFile
			? [{ name: "attach-file", factory: core.attachFile }]
			: []),
		...(core.generateImage
			? [{ name: "generate-image", factory: core.generateImage }]
			: []),
		{ name: "confirmation-gate", factory: core.confirmationGate },
		{ name: "ask-user", factory: core.askUser },
		{ name: "self-compact-guard", factory: core.selfCompactGuard },
		...contributed(plan.compaction ? [plan.compaction] : []),
		...contributed(plan.mcp),
		{ name: "private-memory", factory: core.privateMemory },
		{ name: "surface-formatting", factory: core.surfaceFormatting },
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
