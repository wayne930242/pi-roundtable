import {
	type AgentRuntime,
	type AttachmentPort,
	type ChannelKey,
	type ConversationPort,
	type ConversationRecord,
	type ConversationRegistry,
	type ConversationTurns,
	type IdentityService,
	type Logger,
	type Speaker,
	TIERS,
	type Tier,
	type ToolSelection,
	type TurnAttachments,
} from "pi-roundtable";
import type { TurnBudget } from "./budget.ts";
import type { ClientCallLimits, ClientDesk } from "./client-calls.ts";
import type { Connection, Connections } from "./connections.ts";
import type { TokenVerifier, WebIdentity } from "./oidc.ts";
import type { ErrorCode } from "./protocol.ts";
import type { WebSurface } from "./surface.ts";
import type { UploadLimits } from "./uploads.ts";

/** A conversation kind a client may open. */
export interface WebPersona {
	/** The conversation kind; "owner" and "agent" belong to the host and are refused. */
	kind: string;
	/** How clients list it; default the kind. */
	label?: string;
	/**
	 * Its system prompt, read when a conversation's session is made. Absent when another plugin
	 * contributes the persona of this kind.
	 */
	prompt?(): string;
	/** The lowest tier that may open and use it; default member. */
	minTier?: Tier;
	/** The tools of its turns; default the plugins' `agentSelection`. */
	selection?: ToolSelection;
}

/** The limits of one web chat, those of uploads and attachments included. */
export interface WebChatLimits extends UploadLimits {
	/** Connections one person may hold open at once; default 5. */
	connectionsPerPrincipal: number;
	/** New conversations one person may hold before writing in them; default 20. */
	unusedConversationsPerPrincipal: number;
	/** New conversations one person may open in any hour, written in or not; default 60. */
	newConversationsPerHour: number;
	/**
	 * Interactive turns one person may have running or queued at once, across their conversations; default 2.
	 * A conversation also holds at most its running turn and one queued behind it.
	 */
	turnsPerPrincipal: number;
	/** The longest message text in characters; default 32 000. */
	messageChars: number;
	/** How long an approval or question waits for an answer; default 30 minutes. */
	promptTimeoutMs: number;
	/** How long before a token expires the client is asked for a fresh one; default 60 seconds. */
	reauthLeadMs: number;
	/** What the assistant's tools may ask a client that declared functions to run. */
	clientCalls: ClientCallLimits;
}

export interface WebChatDeps {
	surface: string;
	/** How long a questionnaire no connection can show waits for one before it expires; default 60 seconds. */
	promptGraceMs?: number;
	verifier: TokenVerifier;
	identity(): IdentityService;
	personas: readonly WebPersona[];
	limits: WebChatLimits;
	logger: Logger;
	/** Read when used, after the host linked every plugin. */
	registry(): ConversationRegistry;
	conversations(): ConversationPort;
	/** Where uploaded files wait for the message that uses them. */
	attachments(): AttachmentPort;
	turns(): ConversationTurns;
	runtime(): AgentRuntime;
	/** What the model is told about how replies render; see `WebChatOptions.formatting`. */
	formatting?: string | false;
	/** The clock, in milliseconds; default `Date.now`. */
	now?(): number;
}

/** A person, verified and admitted. */
export interface Admitted {
	identity: WebIdentity;
	speaker: Speaker;
}

export interface Minted {
	principal: string;
	persona: string;
	title?: string;
}

export interface Pending {
	speaker: Speaker;
	/** The connection the message arrived on, which a call the turn makes to its client goes to. */
	connection: Connection;
	/** The origin of the connection the message arrived on. */
	origin?: string;
	persona: WebPersona;
	title: string;
	/** The files the message references, moved into the conversation when it was accepted. */
	attachments?: TurnAttachments;
	/** Whether the conversation was new when the message was accepted. */
	fresh: boolean;
	/** Frees the message's place in the person's turn budget; called once its turn ends or never runs. */
	release(): void;
}

/** Why a conversation or persona was refused. */
export class Refusal extends Error {
	override name = "Refusal";
	readonly code: ErrorCode;

	constructor(code: ErrorCode) {
		super(code);
		this.code = code;
	}
}

const _TITLE_CHARS = 80;

const TITLE_CHARS = 80;
const RESERVED_KINDS = new Set(["owner", "agent"]);

export const atLeast = (tier: Tier, least: Tier) =>
	TIERS.indexOf(tier) >= TIERS.indexOf(least);

/** A conversation's title from its first message: its first line, cut to 80 characters. */
export function titleOf(text: string): string {
	const line = text.trim().split("\n")[0]?.trim() ?? "";
	return line.length > TITLE_CHARS
		? `${line.slice(0, TITLE_CHARS - 1)}…`
		: line;
}

/**
 * The personas by kind; throws on a kind that is not a word, a reserved or repeated kind, a
 * `minTier` that is not a tier, or an empty list. A JavaScript configuration is not type-checked,
 * and an unknown `minTier` would let every tier open the persona.
 */
export function checkPersonas(
	personas: readonly WebPersona[],
): Map<string, WebPersona> {
	const byKind = new Map<string, WebPersona>();
	for (const persona of personas) {
		if (typeof persona.kind !== "string" || persona.kind === "")
			throw new Error(
				`webChat: a persona's kind must be a non-empty string; got ${JSON.stringify(persona.kind)}`,
			);
		if (persona.minTier !== undefined && !TIERS.includes(persona.minTier))
			throw new Error(
				`webChat: persona "${persona.kind}" minTier must be one of ${TIERS.join(", ")}; got ${JSON.stringify(persona.minTier)}`,
			);
		if (RESERVED_KINDS.has(persona.kind))
			throw new Error(
				`webChat: persona kind "${persona.kind}" belongs to the host; name yours another kind`,
			);
		if (byKind.has(persona.kind))
			throw new Error(`webChat: persona "${persona.kind}" is listed twice`);
		byKind.set(persona.kind, persona);
	}
	if (byKind.size === 0)
		throw new Error("webChat: personas is empty; list at least one");
	return byKind;
}

/** What the claim and the turn of a web chat reach in the chat that made them. */
export interface ChatInternals {
	readonly deps: WebChatDeps;
	/** Accepted messages waiting for the claim, by message id. */
	readonly pending: Map<string, Pending>;
	/** Conversations opened but not yet written in. */
	readonly minted: Map<string, Minted>;
	/** Whose each conversation is, once its person wrote in it during this process. */
	readonly owners: Map<string, string>;
	/** Keys proved registered private before any direct runtime operation. */
	readonly registered: Set<ChannelKey>;
	readonly connections: Connections;
	readonly clients: ClientDesk;
	readonly surface: WebSurface;
	readonly turns: TurnBudget;
	open(speaker: Speaker, kind: string, title?: string): string;
	own(
		speaker: Speaker,
		conversation: string,
	): Promise<{
		persona: WebPersona;
		record?: ConversationRecord;
		minted?: Minted;
	}>;
}
