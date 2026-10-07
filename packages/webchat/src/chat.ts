import {
	type AgentRuntime,
	type ChannelClaim,
	type ChannelKey,
	type ConversationPort,
	type ConversationRecord,
	type ConversationRegistry,
	type ConversationTurns,
	channelKey,
	type Logger,
	type RouteSocket,
	type Speaker,
	TIERS,
	type Tier,
	type ToolSelection,
	type TranscriptEntry,
	type TurnResult,
} from "pi-roundtable";
import type { WebAccess } from "./access.ts";
import { type Connection, Connections } from "./connections.ts";
import { TokenRefused, type TokenVerifier, type WebIdentity } from "./oidc.ts";
import { PromptDesk } from "./prompts.ts";
import {
	CLOSE_CODES,
	type ClientFrame,
	type ErrorCode,
	type PersonaSummary,
	parseClientFrame,
	type ServerFrame,
	WEBCHAT_PROTOCOL_VERSION,
} from "./protocol.ts";
import { WebSurface } from "./surface.ts";

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

/** The limits of one web chat. */
export interface WebChatLimits {
	/** Connections one person may hold open at once; default 5. */
	connectionsPerPrincipal: number;
	/** New conversations one person may hold before writing in them; default 20. */
	unusedConversationsPerPrincipal: number;
	/** The longest message text in characters; default 32 000. */
	messageChars: number;
	/** How long an approval or question waits for an answer; default 30 minutes. */
	promptTimeoutMs: number;
	/** How long before a token expires the client is asked for a fresh one; default 60 seconds. */
	reauthLeadMs: number;
}

export interface WebChatDeps {
	surface: string;
	verifier: TokenVerifier;
	access: WebAccess;
	personas: readonly WebPersona[];
	limits: WebChatLimits;
	logger: Logger;
	/** Read when used, after the host linked every plugin. */
	registry(): ConversationRegistry;
	conversations(): ConversationPort;
	turns(): ConversationTurns;
	runtime(): AgentRuntime;
}

/** A person, verified and admitted. */
export interface Admitted {
	identity: WebIdentity;
	speaker: Speaker;
}

interface Minted {
	principal: string;
	persona: string;
	title?: string;
}

interface Pending {
	speaker: Speaker;
	persona: WebPersona;
	title: string;
	/** Whether the conversation was new when the message was accepted. */
	fresh: boolean;
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

const TITLE_CHARS = 80;
/** The longest delay a timer keeps; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const RESERVED_KINDS = new Set(["owner", "agent"]);

const atLeast = (tier: Tier, least: Tier) =>
	TIERS.indexOf(tier) >= TIERS.indexOf(least);

/** A conversation's title from its first message: its first line, cut to 80 characters. */
function titleOf(text: string): string {
	const line = text.trim().split("\n")[0]?.trim() ?? "";
	return line.length > TITLE_CHARS
		? `${line.slice(0, TITLE_CHARS - 1)}…`
		: line;
}

/** The personas by kind; throws on a reserved or repeated kind, or an empty list. */
export function checkPersonas(
	personas: readonly WebPersona[],
): Map<string, WebPersona> {
	const byKind = new Map<string, WebPersona>();
	for (const persona of personas) {
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

/**
 * One web chat: its connections, conversations, prompts, surface, and claim. Every conversation
 * is private to the person who opened it: only they see it listed, read it, write in it, stop it,
 * or answer its prompts; the registry records whose it is at its first turn, and the claim
 * checks that record inside the conversation's queue before each turn.
 */
export class WebChat {
	readonly surface: WebSurface;
	readonly connections: Connections;
	readonly desk: PromptDesk;
	readonly #deps: WebChatDeps;
	readonly #personas: Map<string, WebPersona>;
	/** Conversations opened but not yet written in, so the registry has no record of them. */
	readonly #minted = new Map<string, Minted>();
	/** Whose each conversation is, once its person wrote in it during this process. */
	readonly #owners = new Map<string, string>();
	/** Accepted messages waiting for the claim, by message id. */
	readonly #pending = new Map<string, Pending>();

	constructor(deps: WebChatDeps) {
		this.#deps = deps;
		this.#personas = checkPersonas(deps.personas);
		this.connections = new Connections({
			perPrincipal: deps.limits.connectionsPerPrincipal,
			logger: deps.logger,
		});
		const send = (principal: string, frame: ServerFrame) =>
			this.connections.sendTo(principal, frame);
		this.desk = new PromptDesk({
			send,
			timeoutMs: deps.limits.promptTimeoutMs,
		});
		this.surface = new WebSurface({
			surface: deps.surface,
			principalOf: (conversation) => this.#owners.get(conversation),
			send,
			prompts: this.desk,
		});
	}

	/** The personas the claim's host must know: those this chat contributes a prompt for. */
	get contributedPersonas(): { kind: string; prompt(): string }[] {
		return [...this.#personas.values()].flatMap((persona) =>
			persona.prompt ? [{ kind: persona.kind, prompt: persona.prompt }] : [],
		);
	}

	/** The person a token names, at their tier; throws `TokenRefused`, or a Refusal when they are not admitted. */
	async admit(token: string): Promise<Admitted> {
		const identity = await this.#deps.verifier(token);
		return this.admitIdentity(identity);
	}

	admitIdentity(identity: WebIdentity): Admitted {
		const tier = this.#deps.access.tierOf(identity);
		if (!tier) throw new Refusal("forbidden");
		return {
			identity,
			speaker: { id: identity.id, name: identity.name, tier },
		};
	}

	/** The personas a speaker may open. */
	personasFor(speaker: Speaker): PersonaSummary[] {
		return [...this.#personas.values()]
			.filter((persona) => atLeast(speaker.tier, persona.minTier ?? "member"))
			.map((persona) => ({
				kind: persona.kind,
				label: persona.label ?? persona.kind,
			}));
	}

	#persona(kind: string, speaker: Speaker): WebPersona {
		const persona = this.#personas.get(kind);
		if (!persona || !atLeast(speaker.tier, persona.minTier ?? "member"))
			throw new Refusal("unknown_persona");
		return persona;
	}

	/** Opens a new conversation of a persona for the speaker; its id, unguessable. */
	open(speaker: Speaker, kind: string, title?: string): string {
		this.#persona(kind, speaker);
		const unused = [...this.#minted.values()].filter(
			(minted) => minted.principal === speaker.id,
		).length;
		if (unused >= this.#deps.limits.unusedConversationsPerPrincipal)
			throw new Refusal("too_many_conversations");
		const id = crypto.randomUUID();
		const cut = title === undefined ? undefined : titleOf(title);
		this.#minted.set(id, {
			principal: speaker.id,
			persona: kind,
			...(cut ? { title: cut } : {}),
		});
		return id;
	}

	/**
	 * The speaker's own conversation and its persona; a Refusal when it is someone else's
	 * (`forbidden`) or unknown (`unknown_conversation`), or its persona is no longer theirs.
	 */
	async own(
		speaker: Speaker,
		conversation: string,
	): Promise<{
		persona: WebPersona;
		record?: ConversationRecord;
		minted?: Minted;
	}> {
		const record = await this.#deps
			.registry()
			.get(channelKey(this.#deps.surface, conversation));
		if (record) {
			if (record.principalId !== speaker.id || record.visibility !== "private")
				throw new Refusal("forbidden");
			const persona = this.#persona(record.kind, speaker);
			this.#owners.set(conversation, speaker.id);
			return { persona, record };
		}
		const minted = this.#minted.get(conversation);
		if (!minted) throw new Refusal("unknown_conversation");
		if (minted.principal !== speaker.id) throw new Refusal("forbidden");
		const persona = this.#persona(minted.persona, speaker);
		// The surface learns whose a conversation is from each check that proves it.
		this.#owners.set(conversation, speaker.id);
		return { persona, minted };
	}

	/** The speaker's web conversations, the most recently active first. */
	async list(speaker: Speaker): Promise<ConversationRecord[]> {
		const records = await this.#deps.registry().list({ principal: speaker.id });
		return records.filter(
			(record) =>
				record.surface === this.#deps.surface &&
				record.visibility === "private",
		);
	}

	/** The last `limit` messages of one of the speaker's conversations. */
	async transcript(
		speaker: Speaker,
		conversation: string,
		limit: number,
	): Promise<TranscriptEntry[]> {
		const { record } = await this.own(speaker, conversation);
		if (!record) return [];
		return this.#deps.runtime().recentTranscript(record.key, limit);
	}

	// The WebSocket side.

	/** A socket opened: count it, greet it, send the prompts waiting for its person, and watch its token. */
	opened(socket: RouteSocket<Connection>): void {
		const connection = socket.data;
		if (!this.connections.opened(connection, socket)) {
			socket.close(CLOSE_CODES.notAdmitted, "upgrade took too long");
			return;
		}
		this.#greet(connection);
	}

	#greet(connection: Connection): void {
		const { identity, speaker } = connection;
		this.connections.send(connection, {
			type: "ready",
			protocol: WEBCHAT_PROTOCOL_VERSION,
			speaker: { ...speaker },
			personas: this.personasFor(speaker),
			expiresAt: identity.expiresAt.toISOString(),
		});
		for (const frame of this.desk.openFor(identity.id))
			this.connections.send(connection, frame);
		this.#watchToken(connection);
	}

	/**
	 * Asks for a fresh token `reauthLeadMs` before the token expires and closes the socket when it
	 * does. A token further off than a timer can wait is looked at again once the longest wait passes.
	 */
	#watchToken(connection: Connection): void {
		for (const timer of connection.timers) clearTimeout(timer);
		const left = connection.identity.expiresAt.getTime() - Date.now();
		const lead = this.#deps.limits.reauthLeadMs;
		if (left - lead > MAX_TIMER_MS) {
			connection.timers = [
				setTimeout(() => this.#watchToken(connection), MAX_TIMER_MS),
			];
			return;
		}
		connection.timers = [
			setTimeout(
				() =>
					this.connections.send(connection, {
						type: "reauth",
						expiresAt: connection.identity.expiresAt.toISOString(),
					}),
				Math.max(0, left - lead),
			),
			setTimeout(
				() =>
					connection.socket?.close(CLOSE_CODES.tokenExpired, "token expired"),
				Math.max(0, left),
			),
		];
	}

	closed(socket: RouteSocket<Connection>): void {
		this.connections.closed(socket.data);
	}

	/** One frame from a socket; a refused frame is answered with `error`, never thrown. */
	async message(
		socket: RouteSocket<Connection>,
		raw: string | Uint8Array,
	): Promise<void> {
		const connection = socket.data;
		const frame = parseClientFrame(raw);
		if (!frame) {
			this.connections.send(connection, { type: "error", code: "bad_frame" });
			return;
		}
		try {
			await this.#handle(connection, frame);
		} catch (error) {
			if (!(error instanceof Refusal)) throw error;
			const ref =
				frame.type === "send"
					? frame.id
					: frame.type === "approval" || frame.type === "answer"
						? frame.prompt
						: undefined;
			this.connections.send(connection, {
				type: "error",
				code: error.code,
				...(ref ? { ref } : {}),
			});
		}
	}

	async #handle(connection: Connection, frame: ClientFrame): Promise<void> {
		const { speaker } = connection;
		switch (frame.type) {
			case "auth":
				return this.#reauth(connection, frame.token);
			case "send":
				return this.#send(connection, frame);
			case "stop": {
				await this.own(speaker, frame.conversation);
				this.#deps
					.conversations()
					.stop(channelKey(this.#deps.surface, frame.conversation));
				return;
			}
			case "approval": {
				const refused = this.desk.approve(
					speaker,
					frame.prompt,
					frame.approved,
				);
				if (refused) throw new Refusal(refused);
				return;
			}
			case "answer": {
				const refused = this.desk.answer(speaker, frame.prompt, {
					choices: frame.choices,
					...(frame.text?.trim() ? { text: frame.text.trim() } : {}),
				});
				if (refused) throw new Refusal(refused);
				return;
			}
		}
	}

	async #reauth(connection: Connection, token: string): Promise<void> {
		let admitted: Admitted;
		try {
			admitted = await this.admit(token);
		} catch (error) {
			if (error instanceof TokenRefused) {
				this.#deps.logger.warn(
					{ reason: error.reason },
					"a web chat token renewal was refused",
				);
				connection.socket?.close(CLOSE_CODES.tokenExpired, "token refused");
				return;
			}
			if (error instanceof Refusal) {
				connection.socket?.close(CLOSE_CODES.notAdmitted, "not admitted");
				return;
			}
			throw error;
		}
		// A connection belongs to one person: a token for someone else ends it.
		if (admitted.identity.id !== connection.identity.id) {
			connection.socket?.close(CLOSE_CODES.notAdmitted, "another person");
			return;
		}
		connection.identity = admitted.identity;
		connection.speaker = admitted.speaker;
		this.#greet(connection);
	}

	async #send(
		connection: Connection,
		frame: Extract<ClientFrame, { type: "send" }>,
	): Promise<void> {
		const { speaker } = connection;
		const text = frame.text;
		if (!text.trim() || text.length > this.#deps.limits.messageChars)
			throw new Refusal("bad_frame");
		const conversation =
			frame.conversation ?? this.open(speaker, frame.persona as string);
		const { persona, record, minted } = await this.own(speaker, conversation);
		const messageId = crypto.randomUUID();
		this.#pending.set(messageId, {
			speaker,
			persona,
			title: minted?.title ?? titleOf(text),
			fresh: record === undefined,
		});
		this.connections.send(connection, {
			type: "accepted",
			id: frame.id,
			conversation,
		});
		this.surface.deliver({
			channel: channelKey(this.#deps.surface, conversation),
			messageId,
			authorId: speaker.id,
			authorName: speaker.name,
			authorIsBot: false,
			authorRoleIds: connection.identity.roles,
			isDirect: true,
			mentionsBot: false,
			repliesToBot: false,
			text,
			attachments: [],
		});
	}

	// The claim.

	/** The claim of this chat's conversations: only messages this chat accepted run, as their person's turns. */
	claim(): ChannelClaim {
		const { surface } = this.#deps;
		return {
			name: `webchat:${surface}`,
			priority: 10,
			owns: (channel) => channel.startsWith(`${surface}:`),
			admit: (message) => {
				const pending = this.#pending.get(message.messageId);
				this.#pending.delete(message.messageId);
				if (!pending || pending.speaker.id !== message.authorId)
					return undefined;
				return {
					kind: "turn",
					run: () => this.#turn(message.channel, message.text, pending),
					failure: "a web chat turn failed",
				};
			},
			startFresh: async (channel) => {
				const record = await this.#deps.registry().get(channel);
				await this.#deps.runtime().startFresh(channel);
				return record?.kind ?? "";
			},
			stop: (channel) => this.#deps.runtime().stop(channel),
		};
	}

	/** One turn, after checking again, inside the queue, that the conversation is still the speaker's. */
	async #turn(
		channel: ChannelKey,
		text: string,
		pending: Pending,
	): Promise<void> {
		const { speaker, persona } = pending;
		const conversation = this.surface.conversationOf(channel);
		try {
			await this.own(speaker, conversation);
		} catch (error) {
			if (!(error instanceof Refusal)) throw error;
			this.#deps.logger.warn(
				{ channel, code: error.code },
				"a web chat message was refused before its turn",
			);
			this.connections.sendTo(speaker.id, {
				type: "error",
				code: error.code,
			});
			return;
		}
		await this.#deps.turns().run({
			channel,
			kind: persona.kind,
			text,
			speaker,
			interactive: true,
			...(persona.selection
				? {
						selection: {
							id: `webchat:${persona.kind}`,
							...persona.selection,
						},
					}
				: {}),
			conversation: {
				visibility: "private",
				...(pending.fresh && pending.title ? { title: pending.title } : {}),
			},
			reply: async (result) => this.#reply(speaker.id, conversation, result),
		});
		// The registry now records it, so the opened-but-unused entry is spent.
		this.#minted.delete(conversation);
	}

	#reply(principal: string, conversation: string, result: TurnResult): void {
		if (!result.ok) {
			this.connections.sendTo(principal, {
				type: "failed",
				conversation,
				stopped: result.stopped === true,
			});
			return;
		}
		this.connections.sendTo(principal, {
			type: "reply",
			conversation,
			text: result.text,
			...(result.thinking ? { thinking: result.thinking } : {}),
			...(result.files?.length
				? {
						files: result.files.map((file) => ({
							name: file.name,
							data: Buffer.from(file.data).toString("base64"),
						})),
					}
				: {}),
		});
	}
}
