import type {
	ClientCallError,
	ClientCallOptions,
	ClientCallResult,
	ClientPart,
	ClientPort,
} from "pi-roundtable";
import { RateWindow } from "./budget.ts";
import type { Connection } from "./connections.ts";
import { baseType, bytesMatchType } from "./file-types.ts";
import type {
	ClientCallsAdvertised,
	ClientCancelReason,
	ClientFailure,
	ClientFrame,
	ErrorCode,
	ServerFrame,
} from "./protocol.ts";
import { readLimited } from "./uploads.ts";

/** The limits of the calls the assistant's tools make to a client. */
export interface ClientCallLimits extends ClientCallsAdvertised {
	/** Calls one connection may be asked to run in any minute; default 60. */
	perMinute: number;
}

/** The types a binary part may be: the images a model reads, as a screenshot is. */
const PART_TYPES = ["image/jpeg", "image/png", "image/webp"];
/** The most bytes of the arguments a call carries (UTF-8, as JSON). */
const MAX_ARGS_BYTES = 16 * 1024;
/** The most characters of a client's failure message a tool sees. */
const MESSAGE_CHARS = 300;
const MINUTE_MS = 60_000;

/** Control characters, line and paragraph separators, and bidi controls: none reaches a tool as it is. */
const UNSAFE_CHARS =
	/[\p{Cc}\p{Zl}\p{Zp}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** `text` on one plain line, cut to `MESSAGE_CHARS` characters. */
function plain(text: string): string {
	const line = text.replace(UNSAFE_CHARS, " ").replace(/ +/g, " ").trim();
	const points = Array.from(line);
	return points.length > MESSAGE_CHARS
		? points.slice(0, MESSAGE_CHARS).join("")
		: line;
}

const bytesOf = (text: string) => new TextEncoder().encode(text).length;

/** The longest prompt id a call may name as its approval, as long as the ids a client may answer. */
const APPROVAL_PROMPT_CHARS = 128;

/** Whether `prompt` can be a prompt id: a text of 1 to 128 characters. */
const validPrompt = (prompt: unknown): prompt is string =>
	typeof prompt === "string" &&
	prompt.length > 0 &&
	prompt.length <= APPROVAL_PROMPT_CHARS;

const failure = (
	error: ClientCallError,
	message: string,
): ClientCallResult => ({
	ok: false,
	error,
	message,
});

/** How each failure a client reports reads to a tool. */
const REPORTED: Record<ClientFailure, ClientCallError> = {
	refused: "refused",
	failed: "failed",
	timeout: "timeout",
	stopped: "cancelled",
};

/** Why a binary part was refused, as the HTTP status and error code the client reads. */
export class ClientPartRefusal extends Error {
	override name = "ClientPartRefusal";
	readonly status: number;
	readonly code:
		| "unknown_call"
		| "bad_request"
		| "duplicate_part"
		| "payload_too_large"
		| "unsupported_media_type";

	constructor(status: number, code: ClientPartRefusal["code"]) {
		super(code);
		this.status = status;
		this.code = code;
	}
}

/** The port of one turn: the assistant's tools call through it, and the turn's end closes it. */
export interface TurnClient extends ClientPort {
	/** The turn is over: the call in flight is cancelled, and every later call finds no client. */
	end(): void;
}

interface Open {
	id: string;
	connection: Connection;
	principal: string;
	conversation: string;
	/** The most bytes of JSON this call's answer may take. */
	maxValueBytes: number;
	/** The binary parts uploaded for this call, by index. */
	parts: Map<number, ClientPart>;
	/** The indexes whose body is being read, so one index is never buffered twice at once. */
	receiving: Set<number>;
	/** The turn's port that made the call. */
	owner: object;
	/** Ends the call with `result`; tells the client to stop when `cancel` says why. */
	settle(result: ClientCallResult, cancel?: ClientCancelReason): void;
}

export interface ClientDeskOptions {
	limits: ClientCallLimits;
	/** Sends a frame on one connection; never to the person's other connections. */
	send(connection: Connection, frame: ServerFrame): void;
	/** The clock, in milliseconds; default `Date.now`. */
	now?(): number;
}

/**
 * The calls the assistant's tools make to the client that started their turn, such as a browser
 * extension reading the page the person has open. It is the opposite of `PromptDesk`: a call goes
 * to the one connection the turn started on, never to the person's others; it is answered only by
 * that same connection; and it ends when the connection closes, with no second chance after a
 * reconnect. One call is open on a connection at a time, and each connection may be asked a
 * limited number of calls a minute.
 */
export class ClientDesk {
	readonly #limits: ClientCallLimits;
	readonly #send: ClientDeskOptions["send"];
	readonly #now: () => number;
	readonly #open = new Map<string, Open>();
	readonly #byConnection = new Map<Connection, Open>();
	readonly #gone = new WeakSet<Connection>();
	readonly #rates = new WeakMap<Connection, RateWindow>();

	constructor(options: ClientDeskOptions) {
		this.#limits = options.limits;
		this.#send = options.send;
		this.#now = options.now ?? Date.now;
	}

	/** What `ready` tells a client about the calls it may be asked to run. */
	get advertised(): ClientCallsAdvertised {
		const { timeoutMs, maxTimeoutMs, maxValueBytes, maxParts, maxPartBytes } =
			this.#limits;
		return { timeoutMs, maxTimeoutMs, maxValueBytes, maxParts, maxPartBytes };
	}

	/**
	 * The port of a turn that started on `connection` in `conversation`, naming the functions the
	 * connection declared; undefined when it declared none, so the turn carries no client.
	 */
	portFor(
		connection: Connection,
		conversation: string,
	): TurnClient | undefined {
		const names = connection.clientTools;
		if (!names || names.length === 0) return undefined;
		const declared = [...names];
		const owner = {};
		let ended = false;
		return {
			names: declared,
			call: (name, args, options) => {
				if (ended)
					return Promise.resolve(failure("no_client", "the turn has ended"));
				return this.#call(
					{ connection, conversation, declared, owner },
					name,
					args,
					options,
				);
			},
			end: () => {
				ended = true;
				const open = this.#byConnection.get(connection);
				if (open?.owner === owner)
					open.settle(failure("cancelled", "the turn has ended"), "turn_ended");
			},
		};
	}

	#call(
		turn: {
			connection: Connection;
			conversation: string;
			declared: readonly string[];
			owner: object;
		},
		name: string,
		args: unknown,
		options: ClientCallOptions | undefined,
	): Promise<ClientCallResult> {
		const { connection } = turn;
		const refuse = (error: ClientCallError, message: string) =>
			Promise.resolve(failure(error, message));
		if (this.#gone.has(connection))
			return refuse("disconnected", "the client's connection is closed");
		if (options?.signal?.aborted)
			return refuse("cancelled", "the turn was stopped");
		if (!turn.declared.includes(name))
			return refuse("refused", "the client declared no function of that name");
		let argsJson: string | undefined;
		try {
			argsJson = JSON.stringify(args ?? null);
		} catch {
			return refuse("failed", "the arguments are not JSON");
		}
		if (argsJson === undefined || bytesOf(argsJson) > MAX_ARGS_BYTES)
			return refuse(
				"failed",
				`the arguments must be JSON of at most ${MAX_ARGS_BYTES} bytes`,
			);
		const approval = options?.approval;
		if (approval !== undefined && !validPrompt(approval.prompt))
			return refuse("failed", "approval.prompt must be a prompt id");
		if (this.#byConnection.has(connection))
			return refuse("busy", "another call is open on this client");
		let rate = this.#rates.get(connection);
		if (!rate) {
			rate = new RateWindow(this.#limits.perMinute, MINUTE_MS, this.#now);
			this.#rates.set(connection, rate);
		}
		if (!rate.take("calls"))
			return refuse("busy", "this client was asked too many calls this minute");
		const timeoutMs = bounded(
			options?.timeoutMs,
			this.#limits.timeoutMs,
			this.#limits.maxTimeoutMs,
		);
		const maxValueBytes = bounded(
			options?.maxValueBytes,
			this.#limits.maxValueBytes,
			this.#limits.maxValueBytes,
		);
		return new Promise((resolve) => {
			const id = crypto.randomUUID();
			const signal = options?.signal;
			const onAbort = () =>
				open.settle(
					failure("cancelled", "the turn was stopped"),
					"turn_stopped",
				);
			const timer = setTimeout(
				() =>
					open.settle(
						failure("timeout", "the client did not answer in time"),
						"timeout",
					),
				timeoutMs,
			);
			const open: Open = {
				id,
				connection,
				principal: connection.speaker.principalId,
				conversation: turn.conversation,
				maxValueBytes,
				parts: new Map(),
				receiving: new Set(),
				owner: turn.owner,
				settle: (result, cancel) => {
					if (this.#open.get(id) !== open) return;
					this.#open.delete(id);
					this.#byConnection.delete(connection);
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					if (cancel)
						this.#send(connection, {
							type: "client_cancel",
							call: id,
							reason: cancel,
						});
					resolve(result);
				},
			};
			this.#open.set(id, open);
			this.#byConnection.set(connection, open);
			signal?.addEventListener("abort", onAbort, { once: true });
			this.#send(connection, {
				type: "client_call",
				conversation: turn.conversation,
				call: id,
				name,
				args: JSON.parse(argsJson),
				timeoutMs,
				...(approval ? { approval: { prompt: approval.prompt } } : {}),
			});
		});
	}

	/**
	 * Takes a client's answer; `unknown_call` unless the call is open on exactly this connection and
	 * this person's, so another connection of the same person, or anyone else's, cannot answer it.
	 */
	result(
		connection: Connection,
		frame: Extract<ClientFrame, { type: "client_result" }>,
	): ErrorCode | undefined {
		const open = this.#open.get(frame.call);
		if (
			!open ||
			open.connection !== connection ||
			open.principal !== connection.speaker.principalId
		)
			return "unknown_call";
		if (!frame.ok) {
			open.settle(
				failure(
					REPORTED[frame.code],
					plain(frame.message ?? "") || `the client reported: ${frame.code}`,
				),
			);
			return undefined;
		}
		const size = bytesOf(JSON.stringify(frame.value) ?? "null");
		if (size > open.maxValueBytes) {
			open.settle(
				failure("too_large", `the answer is over ${open.maxValueBytes} bytes`),
			);
			return undefined;
		}
		const declared = frame.parts ?? 0;
		if (declared > this.#limits.maxParts) {
			open.settle(
				failure(
					"failed",
					`the answer declared ${declared} parts, over the limit of ${this.#limits.maxParts}`,
				),
			);
			return undefined;
		}
		const parts: ClientPart[] = [];
		for (let index = 0; index < declared; index++) {
			const part = open.parts.get(index);
			if (!part) {
				open.settle(
					failure(
						"failed",
						`the answer declared ${declared} parts, and part ${index} did not arrive`,
					),
				);
				return undefined;
			}
			parts.push(part);
		}
		open.settle({ ok: true, value: frame.value, parts });
		return undefined;
	}

	/**
	 * Keeps a binary part of the answer to an open call, from the REST request that carries it;
	 * throws a ClientPartRefusal. The call's id is known only to the connection it was sent to, and
	 * the call must be this person's, in this conversation, and still open.
	 */
	async receivePart(
		principal: string,
		conversation: string,
		call: string,
		index: number,
		request: Request,
	): Promise<void> {
		const open = this.#open.get(call);
		if (
			!open ||
			open.principal !== principal ||
			open.conversation !== conversation
		)
			throw new ClientPartRefusal(404, "unknown_call");
		const { maxParts, maxPartBytes } = this.#limits;
		if (!Number.isInteger(index) || index < 0 || index >= maxParts)
			throw new ClientPartRefusal(400, "bad_request");
		const type = baseType(request.headers.get("content-type"));
		if (!type || !PART_TYPES.includes(type))
			throw new ClientPartRefusal(415, "unsupported_media_type");
		if (open.parts.has(index) || open.receiving.has(index))
			throw new ClientPartRefusal(409, "duplicate_part");
		const header = request.headers.get("content-length");
		const length = header === null ? Number.NaN : Number(header);
		if (Number.isFinite(length) && length > maxPartBytes)
			throw new ClientPartRefusal(413, "payload_too_large");
		// The index is held while the body is read, so parallel uploads of it buffer one body.
		open.receiving.add(index);
		let bytes: Uint8Array | undefined;
		try {
			bytes = await readLimited(request, maxPartBytes);
		} finally {
			open.receiving.delete(index);
		}
		if (!bytes) throw new ClientPartRefusal(413, "payload_too_large");
		// The call may have ended, or the same part arrived, while the body was read.
		if (this.#open.get(call) !== open)
			throw new ClientPartRefusal(404, "unknown_call");
		if (open.parts.has(index))
			throw new ClientPartRefusal(409, "duplicate_part");
		if (!bytesMatchType(type, bytes))
			throw new ClientPartRefusal(415, "unsupported_media_type");
		open.parts.set(index, { mimeType: type, data: bytes });
	}

	/** The connection closed: its open call ends as disconnected, and so does every later one. */
	closed(connection: Connection): void {
		this.#gone.add(connection);
		this.#byConnection
			.get(connection)
			?.settle(failure("disconnected", "the client's connection closed"));
	}
}

/** `asked` as a whole number of at most `max`, or `fallback` when it is no positive number. */
function bounded(asked: number | undefined, fallback: number, max: number) {
	if (typeof asked !== "number" || !Number.isFinite(asked) || asked < 1)
		return Math.min(fallback, max);
	return Math.min(Math.floor(asked), max);
}
