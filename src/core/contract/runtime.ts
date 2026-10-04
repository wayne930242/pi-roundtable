import type { TurnAttachments } from "../domain/attachment.ts";
import type {
	ChannelKey,
	PendingConfirmation,
	TranscriptEntry,
	TurnResult,
} from "../domain/conversation.ts";
import type { OwnerPrompts } from "../domain/owner-prompts.ts";
import type { TurnRequest } from "../domain/ports.ts";
import type { Logger } from "../log.ts";
import type { ThinkingSetting } from "../models.ts";
import type { HostEnv, LinkedSessions } from "../plugin.ts";
import type { AgentTurnScope } from "../sessions.ts";
import type { Speaker } from "../speakers.ts";
import type { ToolTiers } from "../tool-tiers.ts";
import type { Judge } from "./providers.ts";

/** A conversation's context use after its latest turn. */
export interface ContextUse {
	/** Null right after a compaction, until the next model response. */
	tokens: number | null;
	contextWindow: number;
}

/**
 * Runs the conversations of the agent server, and of every claim that runs turns through
 * `context.turns`: one persistent conversation per channel key (an agent's conversation has the
 * key of its `AgentTurnScope.session`), its turns, its held actions, and its history. A plugin
 * replaces the whole runtime by filling the `runtime` provider slot; the default runs Pi.
 */
export interface AgentRuntime {
	/**
	 * Runs one turn and returns how it ended. A turn that cannot run is `{ ok: false }`; a throw is
	 * settled into a failed result by the caller.
	 */
	runTurn(request: TurnRequest): Promise<TurnResult>;
	/**
	 * Adds the message to the conversation's running turn when that turn is steerable and holds no
	 * actions; false when the message must wait for its own turn.
	 */
	steer(
		conversation: ChannelKey,
		text: string,
		attachments: TurnAttachments,
		/** The message's author; a turn another speaker started takes no steering from them. */
		speakerId?: string,
	): Promise<boolean>;
	/** Aborts the conversation's running turn and drops what was steered into it; false when none runs. */
	stop(conversation: ChannelKey): boolean;
	/** Archives a conversation and drops its held actions; called between turns. */
	startFresh(conversation: ChannelKey): Promise<void>;
	/** Like `startFresh`, but removes the conversation and every archive of it for good; called between turns. */
	deleteConversation(conversation: ChannelKey): Promise<void>;
	/** The conversation's held actions known in memory since startup. */
	pendingConfirmation(
		conversation: ChannelKey,
	): PendingConfirmation | undefined;
	/** The conversation's held actions, restored from the store after a restart. */
	heldActions(
		conversation: ChannelKey,
	): Promise<PendingConfirmation | undefined>;
	recentTranscript(
		conversation: ChannelKey,
		limit: number,
	): Promise<TranscriptEntry[]>;
	/** Undefined when unknown; the team status shows no context bar for the conversation then. */
	contextUsage?(conversation: ChannelKey): ContextUse | undefined;
	/** Runs in the host's preflight, before anything starts; a throw stops the boot. */
	preflight?(): Promise<void>;
	/** Runs when the host stops the agent server's runtime service. */
	dispose?(): Promise<void> | void;
}

/** A skill file a session loads; only its name and description enter the prompt. */
export interface LoadedSkill {
	name: string;
	description: string;
	file: string;
}

/** The agent server's per-agent settings, which a runtime reads when it runs an agent's turn. */
export interface AgentSessions {
	/** The shell's working directory, shared by every agent; writes outside it are held. */
	workDir: string;
	/**
	 * The host's scratch dir: the agents' shell runs with TMPDIR pointing to it, and writes and
	 * removals inside it run without a hold, like the workspace's.
	 */
	scratchDir?: string;
	/**
	 * The skills the agent carries, read at the start of every run; a change rebuilds its
	 * sessions, keeping their history.
	 */
	skills(name: string): readonly LoadedSkill[];
	/** The agent's model (`<provider>/<id>`) and thinking setting, read at the start of every run. */
	modelOf(name: string): { model: string; thinking: ThinkingSetting };
	/** The channel the scope's turns run in: the group's for a seat in one, else the agent's own. */
	turnChannel(scope: AgentTurnScope): ChannelKey;
}

/** Where a runtime keeps each conversation's held actions, so they survive a restart. */
export interface HeldActionStore {
	/** The held actions stored for the conversation, if any. */
	load(conversation: ChannelKey): Promise<PendingConfirmation | undefined>;
	/** Stores the conversation's held actions; `undefined` clears them. */
	save(
		conversation: ChannelKey,
		held: PendingConfirmation | undefined,
	): Promise<void>;
}

/** What the agent server hands a runtime provider when it builds the runtime. */
export interface RuntimeDeps {
	logger: Logger;
	/** The host's locale and time zone. */
	env: HostEnv;
	/** Who the conversations serve. */
	owner: { id: string; name: string };
	/**
	 * The linked session parts: hold rules, packages, session tools, and personas. Read once the
	 * host has linked them, from the preflight on; calling it during the factory throws.
	 */
	sessions(): LinkedSessions;
	/** What each tool needs; plugin tools are added when the host links, so ask at use time. */
	toolTiers: ToolTiers;
	/**
	 * The owner's approval and question prompts in a conversation, from its chat surface; undefined
	 * when the surface has none, and the action then waits for the owner's next message.
	 */
	prompts(
		conversation: ChannelKey,
		speaker?: Speaker,
	): OwnerPrompts | undefined;
	/** The agent server's per-agent settings, for agent turns. */
	agents: AgentSessions;
	/** Where held actions persist across restarts. */
	confirmations: HeldActionStore;
	/** The host's judge, resolved from the `judge` slot. */
	judge: Judge;
}

/** Builds the runtime, once, when the agent server sets up. */
export type RuntimeFactory = (deps: RuntimeDeps) => AgentRuntime;
