import {
	type ChannelClaim,
	type ChannelKey,
	type ConversationRecord,
	channelKey,
	type RouteSocket,
	type Speaker,
	type TranscriptEntry,
} from "pi-roundtable";
import { RateWindow, TurnBudget } from "./budget.ts";
import { webChatClaim } from "./chat-claim.ts";
import { acceptMessage } from "./chat-send.ts";
import {
	type Admitted,
	atLeast,
	type ChatInternals,
	checkPersonas,
	type Minted,
	type Pending,
	Refusal,
	titleOf,
	type WebChatDeps,
	type WebPersona,
} from "./chat-types.ts";
import { ClientDesk } from "./client-calls.ts";
import { parseClientFrame } from "./client-frame.ts";
import { type Connection, Connections } from "./connections.ts";
import { identityActor, TokenRefused, type WebIdentity } from "./oidc.ts";
import { PromptDesk } from "./prompts.ts";
import {
	ADVERTISED_ASK,
	CLOSE_CODES,
	type ClientFrame,
	type PersonaSummary,
	type ServerFrame,
	WEBCHAT_PROTOCOL_VERSION,
} from "./protocol.ts";
import { WebSurface } from "./surface.ts";
import { type UploadedFile, Uploads } from "./uploads.ts";

export {
	type Admitted,
	checkPersonas,
	Refusal,
	type WebChatDeps,
	type WebChatLimits,
	type WebPersona,
} from "./chat-types.ts";

const HOUR_MS = 60 * 60_000;
/** The longest delay a timer keeps; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/**
 * One web chat: its connections, conversations, prompts, surface, and claim. Every conversation
 * is private to the person who opened it: only they see it listed, read it, write in it, stop it,
 * or answer its prompts; the registry records whose it is at its first turn, and the claim
 * checks that record inside the conversation's queue before each turn.
 */
export class WebChat {
	readonly surface: WebSurface;
	readonly uploads: Uploads;
	readonly connections: Connections;
	readonly desk: PromptDesk;
	/** The calls the assistant's tools make to the client that started their turn. */
	readonly clients: ClientDesk;
	readonly #deps: WebChatDeps;
	readonly #personas: Map<string, WebPersona>;
	/** Conversations opened but not yet written in, so the registry has no record of them. */
	readonly #minted = new Map<string, Minted>();
	/** Whose each conversation is, once its person wrote in it during this process. */
	readonly #owners = new Map<string, string>();
	/** Keys proved registered private before any direct runtime operation. */
	readonly #registered = new Set<ChannelKey>();
	/** Accepted messages waiting for the claim, by message id. */
	readonly #pending = new Map<string, Pending>();
	/** Each person's turns, running or queued. */
	readonly #turns: TurnBudget;
	/** Each person's newly opened conversations. */
	readonly #opened: RateWindow;
	readonly #internals: ChatInternals;

	constructor(deps: WebChatDeps) {
		this.#deps = deps;
		this.uploads = new Uploads({
			limits: deps.limits,
			attachments: deps.attachments,
			...(deps.now ? { now: deps.now } : {}),
		});
		this.#personas = checkPersonas(deps.personas);
		this.#turns = new TurnBudget(deps.limits.turnsPerPrincipal);
		this.#opened = new RateWindow(
			deps.limits.newConversationsPerHour,
			HOUR_MS,
			deps.now ?? Date.now,
		);
		this.connections = new Connections({
			perPrincipal: deps.limits.connectionsPerPrincipal,
			logger: deps.logger,
		});
		const send = (principal: string, frame: ServerFrame) =>
			this.connections.sendTo(principal, frame);
		this.desk = new PromptDesk({
			send,
			sendWhere: (principal, frame, where) =>
				this.connections.sendTo(principal, frame, where),
			supports: (principal) => this.connections.askSupports(principal),
			sendOne: (connection, frame) => this.connections.send(connection, frame),
			timeoutMs: deps.limits.promptTimeoutMs,
			...(deps.promptGraceMs === undefined
				? {}
				: { graceMs: deps.promptGraceMs }),
		});
		this.clients = new ClientDesk({
			limits: deps.limits.clientCalls,
			send: (connection, frame) => this.connections.send(connection, frame),
			...(deps.now ? { now: deps.now } : {}),
		});
		this.surface = new WebSurface({
			surface: deps.surface,
			principalOf: (conversation) => this.#owners.get(conversation),
			send,
			prompts: this.desk,
			...(deps.formatting === undefined ? {} : { formatting: deps.formatting }),
		});
		this.#internals = {
			deps,
			pending: this.#pending,
			minted: this.#minted,
			owners: this.#owners,
			registered: this.#registered,
			turns: this.#turns,
			connections: this.connections,
			clients: this.clients,
			surface: this.surface,
			own: (speaker, conversation) => this.own(speaker, conversation),
			open: (speaker, kind, title) => this.open(speaker, kind, title),
		};
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

	async admitIdentity(identity: WebIdentity): Promise<Admitted> {
		const speaker = await this.#deps
			.identity()
			.resolve(identityActor(identity, this.#deps.surface));
		if (!speaker) throw new Refusal("forbidden");
		return { identity, speaker };
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
			(minted) => minted.principal === speaker.principalId,
		).length;
		if (unused >= this.#deps.limits.unusedConversationsPerPrincipal)
			throw new Refusal("too_many_conversations");
		if (!this.#opened.take(speaker.principalId))
			throw new Refusal("too_many_conversations");
		const id = crypto.randomUUID();
		const cut = title === undefined ? undefined : titleOf(title);
		this.#minted.set(id, {
			principal: speaker.principalId,
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
			if (
				record.principalId !== speaker.principalId ||
				record.visibility !== "private"
			)
				throw new Refusal("forbidden");
			const persona = this.#persona(record.kind, speaker);
			this.#owners.set(conversation, speaker.principalId);
			this.#registered.add(record.key);
			return { persona, record };
		}
		const minted = this.#minted.get(conversation);
		if (!minted) throw new Refusal("unknown_conversation");
		if (minted.principal !== speaker.principalId)
			throw new Refusal("forbidden");
		const persona = this.#persona(minted.persona, speaker);
		// The surface learns whose a conversation is from each check that proves it.
		this.#owners.set(conversation, speaker.principalId);
		return { persona, minted };
	}

	/**
	 * Keeps the request's body as a file for one of the speaker's conversations until a message
	 * uses it; a Refusal when the conversation is not theirs, an UploadRefusal when the file is not
	 * accepted.
	 */
	async upload(
		speaker: Speaker,
		conversation: string,
		request: Request,
		name: string | null,
	): Promise<UploadedFile> {
		await this.own(speaker, conversation);
		return this.uploads.receive(
			request,
			channelKey(this.#deps.surface, conversation),
			speaker.principalId,
			name,
		);
	}

	/**
	 * Keeps a binary part of the answer to a call the assistant made to the speaker's client, for the
	 * conversation it was made in; a Refusal when the conversation is not theirs, a ClientPartRefusal
	 * when the part is not accepted.
	 */
	async clientPart(
		speaker: Speaker,
		conversation: string,
		call: string,
		index: number,
		request: Request,
	): Promise<void> {
		await this.own(speaker, conversation);
		await this.clients.receivePart(
			speaker.principalId,
			conversation,
			call,
			index,
			request,
		);
	}

	/** The speaker's web conversations, the most recently active first. */
	async list(speaker: Speaker): Promise<ConversationRecord[]> {
		const records = await this.#deps
			.registry()
			.list({ principal: speaker.principalId });
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
			attachments: this.uploads.advertised,
			clientCalls: this.clients.advertised,
			prompts: { ask: ADVERTISED_ASK },
			expiresAt: identity.expiresAt.toISOString(),
		});
		for (const frame of this.desk.openFor(
			speaker.principalId,
			connection.askSupport,
		))
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
		this.clients.closed(socket.data);
		this.connections.closed(socket.data);
		this.desk.closed(socket.data.speaker.principalId);
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
					: frame.type === "approval" ||
							frame.type === "answer" ||
							frame.type === "answers"
						? frame.prompt
						: frame.type === "client_result"
							? frame.call
							: undefined;
			this.connections.send(connection, {
				type: "error",
				code: error.code,
				...(ref ? { ref } : {}),
			});
		}
	}

	async #handle(connection: Connection, frame: ClientFrame): Promise<void> {
		// Token facts remain verified until expiry, but linked principals and persistent roles can
		// change while the socket is open. In particular, an approval must use the current tier.
		if (frame.type !== "auth") {
			let current: Speaker;
			try {
				current = (await this.admitIdentity(connection.identity)).speaker;
			} catch (error) {
				if (!(error instanceof Refusal)) throw error;
				connection.socket?.close(CLOSE_CODES.notAdmitted, "not admitted");
				return;
			}
			if (current.principalId !== connection.speaker.principalId) {
				connection.socket?.close(CLOSE_CODES.notAdmitted, "another person");
				return;
			}
			connection.speaker = current;
		}
		const { speaker } = connection;
		switch (frame.type) {
			case "auth":
				return this.#reauth(connection, frame.token);
			case "send":
				return acceptMessage(this.#internals, connection, frame);
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
			case "prompt_features":
			case "answers": {
				const refused = this.desk.receive(connection, speaker, frame);
				if (refused) throw new Refusal(refused);
				return;
			}
			case "client_hello":
				connection.clientTools = frame.tools;
				return;
			case "client_result": {
				const refused = this.clients.result(connection, frame);
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
		if (admitted.speaker.principalId !== connection.speaker.principalId) {
			connection.socket?.close(CLOSE_CODES.notAdmitted, "another person");
			return;
		}
		connection.identity = admitted.identity;
		connection.speaker = admitted.speaker;
		this.#greet(connection);
	}

	/** The claim of this chat's conversations: only messages this chat accepted run, as their person's turns. */
	claim(): ChannelClaim {
		return webChatClaim(this.#internals);
	}
}
