import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { PluginError } from "./errors.ts";
import type { Principal } from "./identity/principal-store.ts";
import type { OwnerIdentity } from "./identity.ts";
import type { Speaker } from "./speakers.ts";

/** `<surface>:<channel id>`, for example `discord:1234`. A DM is one channel. */
export type ChannelKey = `${string}:${string}`;

/** Who an agent-server turn belongs to; see the agent team. */
export interface AgentTurnScope {
	/** The agent's name. */
	name: string;
	/** The conversation and its held actions: the agent's channel, or its seat in a group. */
	session: ChannelKey;
	/** The agent's own channel, where its schedules and delegated reports belong. */
	home: ChannelKey;
	/** The group, for a member's conversation in one. */
	group?: string;
}

/** The tools a turn or a transient task may use: named tools, plus every tool of each named group. */
export interface ToolSelection {
	tools: readonly string[];
	groups: readonly string[];
}

/** The tools of one turn, named so its held actions and log lines say which selection ran. */
export interface TurnSelection extends ToolSelection {
	id: string;
}

/** A task that runs now in a fresh, unsaved session and reports its final text. */
export interface TransientTask {
	selection: ToolSelection;
	text: string;
	/** Aborted after this long. */
	timeoutMs: number;
	signal?: AbortSignal;
	/** Tools of the selection the task may not use. */
	exclude: readonly string[];
	/** Called after the session is disposed, whether the task succeeded or failed. */
	onFinished?(toolCalls: readonly string[]): void;
}

/**
 * Whom a session's conversation serves, fixed when the session is made: `private` to one
 * principal, whose name and pronouns are known when the host has a record of them, or `shared`
 * by whoever its claim admits, as an agent's session always is.
 */
export type SessionConversation =
	| { visibility: "private"; principalId: string; principal?: Principal }
	| { visibility: "shared" };

/** What one Pi session is for, as a session tool's factory sees it. */
export interface SessionContext {
	/** "agent" for an agent's session; otherwise the kind of conversation, which the claim that owns the channel names. */
	kind: string;
	/** Where the session's schedules and delegated reports belong: the agent's own channel, or the owner's. */
	homeChannel: ChannelKey;
	/** Where the session's turns run: a group's channel for an agent's seat in it, else the home channel. */
	turnChannel: ChannelKey;
	/** The agent the session belongs to; absent for the owner's sessions. */
	agent?: AgentTurnScope;
	/** Wraps a compactor so the core's compaction tiers decide when it may answer. */
	compaction: { wrap(compactor: ExtensionFactory): ExtensionFactory };
	/**
	 * Whom the conversation serves, as `TurnRequest.conversation` or the host's record says when the
	 * session is made; shared when neither says. A private conversation's tools serve its person:
	 * their memory, their notices. A shared one's serve each turn's speaker.
	 */
	conversation: SessionConversation;
	/**
	 * Whom the session's tool descriptions address, fixed when it is made: a private conversation's
	 * person by their name and pronouns, the primary owner exactly as 0.8 wrote them, and
	 * `THE_SPEAKER` in a shared conversation, where each turn's prompt says who speaks.
	 */
	addressee: OwnerIdentity;
	/**
	 * Whose memory the session's turns may read: `"speaker"` (the default), as `conversation` and
	 * each turn's speaker decide, or `"none"`, for a persona that declares it; then no memory loads.
	 * While the running turn is one the agent server keeps out of memory (`AgentSessions.memory`),
	 * it reads `"none"` for that turn alone.
	 */
	memory: "speaker" | "none";
	/**
	 * The shared workspace of a session with a shell, and its scratch dir: the roots its shell writes
	 * in without a hold, and where its tools may read a file by path. Absent for a session without one.
	 */
	workspace?: { workspace: string; scratchDir?: string };
	/** Where the session's conversation keeps the files people attached; absent when the session keeps none. */
	attachmentDir?: string;
	/** The person the session's running turn is for; undefined between turns. */
	speaker(): Speaker | undefined;
	/** Runs a task beside this session, under its confirmation gate. */
	runTask(task: TransientTask): Promise<string>;
}

/**
 * One contribution's state for a session being built. A new revision rebuilds each open
 * session on its next turn, keeping its history.
 */
export interface SessionToolSnapshot {
	revision: number;
	/** The session's extension, or null when the contribution does not apply to it. */
	factory(session: SessionContext): ExtensionFactory | null;
	/** Tool groups a selection may name, in order. */
	groups?: readonly { name: string; tools: readonly string[] }[];
	/** Tools a new session waits for, because they register after it loads. */
	awaitTools?: readonly string[];
	/** Tools startup refuses to run without. */
	requiredTools?: readonly string[];
}

/** A named Pi extension a plugin adds to every conversation session, at its phase's position. */
export interface SessionTool {
	/** The extension's name, unique across sessions. */
	name: string;
	phase: "tools" | "compaction" | "mcp";
	/**
	 * The compaction phase's marker: the `engine` its compactions record in their details, which is how
	 * the core tells them from Pi's own.
	 */
	engine?: string;
	/** Synchronous and side-effect free; read once per session build and before each turn. */
	snapshot(): SessionToolSnapshot;
}

/** Extensions the core places itself; no contribution may take their names. */
const CORE_EXTENSIONS = [
	"read-attachment",
	"attach-file",
	"confirmation-gate",
	"ask-user",
	"self-compact-guard",
	"active-tools",
] as const;

/** Session tools grouped by phase, each group in registration order. */
export interface SessionPlan {
	tools: readonly SessionTool[];
	compaction?: SessionTool;
	mcp: readonly SessionTool[];
}

/** Checks the contributions and orders them by phase; throws PluginError on a clash. */
export function compileSessionPlan(
	contributions: readonly SessionTool[],
): SessionPlan {
	const reserved = new Set<string>(CORE_EXTENSIONS);
	const names = new Set<string>();
	for (const { name } of contributions) {
		if (reserved.has(name))
			throw new PluginError(
				`session tool ${name} takes a core extension name. Rename it.`,
			);
		if (names.has(name))
			throw new PluginError(
				`session tool ${name} is registered twice. Rename one of the two.`,
			);
		names.add(name);
	}
	const compactors = contributions.filter((c) => c.phase === "compaction");
	if (compactors.length > 1)
		throw new PluginError(
			`only one compactor may run; got ${compactors.map((c) => c.name).join(", ")}. Keep one.`,
		);
	const unmarked = compactors.find((c) => !c.engine);
	if (unmarked)
		throw new PluginError(
			`compactor ${unmarked.name} needs an engine: the value its compactions record as details.engine.`,
		);
	const plan: SessionPlan = {
		tools: contributions.filter((c) => c.phase === "tools"),
		mcp: contributions.filter((c) => c.phase === "mcp"),
	};
	if (compactors[0]) plan.compaction = compactors[0];
	return plan;
}

/** A plan's contributions in the order their extensions load. */
export function planOrder(plan: SessionPlan): readonly SessionTool[] {
	return [
		...plan.tools,
		...(plan.compaction ? [plan.compaction] : []),
		...plan.mcp,
	];
}
