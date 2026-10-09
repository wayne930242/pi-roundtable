import type { ChannelKey, Logger } from "pi-roundtable";
import { HARD_COMPACT_TOKENS, scrubDiagnostic } from "pi-roundtable/kit";
import {
	type BrokerListener,
	listenBroker,
	type SandboxCredentialScope,
} from "./broker.ts";
import { piModelInput } from "./pi-model-input.ts";
import {
	PI_MEDIA_LIMITS,
	type PiCompaction,
	type PiCompactionReport,
	type PiCompactRequest,
	type PiCompactResponse,
	type PiThinkingLevel,
	type PiToolResponse,
	type PiTurnRequest,
	type PiTurnResponse,
	type PiWorkerConfig,
	validateCompactionReport,
	validateCompactRequest,
	validateImages,
	validateReplyFiles,
} from "./pi-protocol.ts";
import { boundedText, isRecord } from "./protocol.ts";

export interface PiHostContext {
	channel: ChannelKey;
	profile: string;
	speaker: { id: string; name: string; principalId?: string };
	/** The host-judged level for this turn; the worker can request less but never more. */
	thinking: PiThinkingLevel;
	signal: AbortSignal;
	/** When the turn must end, in epoch milliseconds; a host compactor gets at most half the time left. */
	deadline?: number;
}
export interface PiMcpServer {
	name: string;
	url: string;
	tools: readonly string[];
}
/** Defaults for a host compactor's limits. */
export const PI_COMPACT_LIMITS = {
	/** A larger compact request falls back to Pi's summary unread. */
	requestBytes: 32 * 1024 * 1024,
	/** A compactor still running after this falls back to Pi's summary. */
	timeoutMs: 120_000,
	/** Compact requests one turn may make; the rest fall back to Pi's summary. */
	compactsPerTurn: 3,
	/** Compaction reports one turn may send. */
	reportsPerTurn: 16,
} as const;
/** Compacts a sandbox session on the host, with what the worker cannot reach (a remote service, say). */
export interface PiCompactor {
	/** The `engine` this compactor's compactions record in their details; the broker stamps it. */
	engine: string;
	/** A compaction, or undefined to leave it to Pi's own summary. A throw also falls back. */
	compact(
		request: PiCompactRequest,
		context: { channel: ChannelKey; signal: AbortSignal },
	): Promise<PiCompaction | undefined>;
	/** Longest a compaction may take before Pi's summary runs instead (default 120 seconds). */
	timeoutMs?: number;
	/** Largest request accepted, in bytes (default 32 MiB); a larger one falls back to Pi's summary. */
	maxRequestBytes?: number;
}
export interface PiBrokerOptions {
	model: string;
	/** Host-only, read before each model call for its channel and speaker; a zero-argument function still works. Return `undefined` or an empty string when the scope has no token: the call fails rather than using another credential. Never sent to the worker. */
	oauthToken: (
		scope: SandboxCredentialScope,
	) => string | undefined | Promise<string | undefined>;
	tools?: {
		names: readonly string[];
		call(
			name: string,
			input: Record<string, unknown>,
			context: PiHostContext,
		): Promise<PiToolResponse>;
	};
	mcp?: {
		servers: readonly PiMcpServer[];
		token: () => string | Promise<string>;
	};
	upstream?: string;
	fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
	maxCalls?: number;
	maxOutputTokens?: number;
	/** Trusted endpoints can use HTTP only for explicitly configured local MCP. */
	allowHttpMcp?: boolean;
	/** Host-side compaction; without it the worker compacts with Pi's summary alone. */
	compaction?: PiCompactor;
	/** Receives upstream failures and the worker's compactions, per channel. */
	logger?: Logger;
}
const MODEL_PATHS = new Set([
	"/anthropic/v1/messages",
	"/anthropic/v1/messages/count_tokens",
]);
const HEADERS = [
	"anthropic-version",
	"anthropic-beta",
	"content-type",
	"accept",
	"user-agent",
	"x-app",
];
const RESPONSE_HEADERS = ["content-type", "request-id", "x-should-retry"];
/** Headers the worker's client uses to back off or recover; each value is short and checked. */
function passthroughHeader(name: string): boolean {
	return (
		name === "retry-after" ||
		name.startsWith("anthropic-ratelimit-") ||
		RESPONSE_HEADERS.includes(name)
	);
}
/** An error's name, message and cause chain, for a log line. */
export function errorText(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const text = `${error.name}: ${error.message}`;
	return error.cause === undefined
		? text
		: `${text} (cause: ${errorText(error.cause)})`;
}
function endpoint(raw: string, allowHttp = false): URL {
	// pi-lens-ignore: unchecked-throwing-call -- invalid trusted endpoint configuration must fail startup.
	const url = new URL(raw);
	if (
		!(url.protocol === "https:" || (allowHttp && url.protocol === "http:")) ||
		url.username ||
		url.password ||
		url.hash ||
		url.search
	)
		throw new Error("Invalid trusted endpoint");
	return url;
}
/**
 * Watches a server-sent event stream as it passes and reports its first `error` event: an
 * upstream can fail mid-answer after a 200, which the status alone never shows.
 */
function sseErrorWatcher(
	onError: (data: string) => void,
): (chunk: Uint8Array, done: boolean) => void {
	const decoder = new TextDecoder();
	let pending = "";
	let reported = false;
	const scan = (event: string) => {
		const lines = event.split(/\r?\n/);
		const type = lines
			.find((line) => line.startsWith("event:"))
			?.slice(6)
			.trim();
		const data = lines
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /, ""))
			.join("\n");
		let typed: unknown;
		try {
			typed = JSON.parse(data);
		} catch {
			typed = undefined;
		}
		if (type === "error" || (isRecord(typed) && typed.type === "error")) {
			reported = true;
			onError(data);
		}
	};
	return (chunk, done) => {
		if (reported) return;
		pending += decoder.decode(chunk, { stream: !done });
		const events = pending.split(/\r?\n\r?\n/);
		pending = done ? "" : (events.pop() ?? "");
		// An event this long is no error report; keep scanning without holding it.
		if (pending.length > 64 * 1024) pending = "";
		for (const event of events) if (!reported) scan(event);
	};
}

function streamBounded(
	response: Response,
	signal: AbortSignal,
	maxBytes: number,
	secret: string,
	onFailure: (error: unknown) => void,
	watch?: (chunk: Uint8Array, done: boolean) => void,
): ReadableStream<Uint8Array> {
	const reader = response.body?.getReader();
	let total = 0;
	let carry = Buffer.alloc(0);
	const variants = [
		secret,
		encodeURIComponent(secret),
		Buffer.from(secret).toString("base64"),
		Buffer.from(secret).toString("base64url"),
		Buffer.from(secret).toString("hex"),
	]
		.filter(Boolean)
		.map((s) => Buffer.from(s));
	const tail = Math.max(0, ...variants.map((s) => s.length)) - 1;
	return new ReadableStream({
		async pull(controller) {
			try {
				signal.throwIfAborted();
				const result = await reader?.read();
				const data = Buffer.concat([carry, result?.value ?? new Uint8Array()]);
				if (variants.some((s) => data.includes(s)))
					throw new Error("Credential reflected");
				total += result?.value?.byteLength ?? 0;
				if (total > maxBytes) throw new Error("Response too large");
				watch?.(result?.value ?? new Uint8Array(), !result || result.done);
				if (!result || result.done) {
					if (data.length) controller.enqueue(data);
					controller.close();
					return;
				}
				const cut = Math.max(0, data.length - tail);
				if (cut) controller.enqueue(data.subarray(0, cut));
				carry = data.subarray(cut);
			} catch (error) {
				onFailure(error);
				await reader?.cancel().catch(() => {});
				controller.error(new Error("Broker response failed"));
			}
		},
		cancel: () => reader?.cancel(),
	});
}

/** At most `limit` bytes of a body as text; the rest is cancelled, never read. */
async function bodyHead(
	body: ReadableStream<Uint8Array>,
	limit: number,
): Promise<string> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (size < limit) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			size += value.byteLength;
		}
	} catch {
		// The worker's branch reports a broken stream; the log keeps what arrived.
	} finally {
		await reader.cancel().catch(() => {});
	}
	return Buffer.concat(chunks).subarray(0, limit).toString("utf8");
}
/** A credential as it may appear in text: raw, URL-encoded, base64 and hex. */
function secretForms(secret: string): string[] {
	if (!secret) return [];
	return [
		secret,
		encodeURIComponent(secret),
		Buffer.from(secret).toString("base64"),
		Buffer.from(secret).toString("base64url"),
		Buffer.from(secret).toString("hex"),
	];
}
/** A compactor's answer, or a rejection once the signal aborts, even if the compactor ignores it. */
function abortableCompact<T>(
	promise: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		promise
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort));
	});
}

/** Explicit subscription mode. A broker is idle except while the host binds one admitted turn. */
export class PiSandboxBroker {
	readonly #options: PiBrokerOptions;
	#ready = false;
	#receivingResult = false;
	#next: ((turn: PiTurnRequest) => void) | undefined;
	#pending:
		| {
				request: PiTurnRequest;
				signal: AbortSignal;
				resolve(result: PiTurnResponse): void;
				reject(error: Error): void;
				delivered: boolean;
		  }
		| undefined;
	isReady(): boolean {
		return this.#ready;
	}
	execute(
		request: PiTurnRequest,
		signal: AbortSignal,
	): Promise<PiTurnResponse> {
		if (this.#pending) return Promise.reject(new Error("Worker is busy"));
		return new Promise((resolve, reject) => {
			const abort = () => {
				this.#pending = undefined;
				reject(new Error("Turn cancelled"));
			};
			if (signal.aborted) {
				abort();
				return;
			}
			signal.addEventListener("abort", abort, { once: true });
			this.#pending = {
				request,
				signal,
				delivered: false,
				resolve: (result) => {
					signal.removeEventListener("abort", abort);
					this.#pending = undefined;
					resolve(result);
				},
				reject,
			};
			this.#next?.(request);
		});
	}
	async #worker(request: Request, path: string): Promise<Response> {
		if (path === "/worker/ready" && request.method === "POST") {
			this.#ready = true;
			this.#rearmStartup();
			return new Response("Ready");
		}
		if (path === "/worker/config" && request.method === "GET") {
			const compaction = this.#options.compaction;
			return Response.json({
				...(compaction ? { compaction: { engine: compaction.engine } } : {}),
			} satisfies PiWorkerConfig);
		}
		if (path === "/worker/next" && request.method === "GET") {
			if (this.#next) return new Response("Already waiting", { status: 429 });
			if (this.#pending && !this.#pending.delivered) {
				this.#pending.delivered = true;
				return Response.json(this.#pending.request);
			}
			return new Promise((resolve) => {
				const finish = (response: Response) => {
					request.signal.removeEventListener("abort", abort);
					clearTimeout(timer);
					this.#next = undefined;
					resolve(response);
				};
				const abort = () => finish(new Response("Retry", { status: 408 }));
				const timer = setTimeout(abort, 45_000);
				request.signal.addEventListener("abort", abort, { once: true });
				this.#next = (turn) => {
					if (this.#pending) this.#pending.delivered = true;
					finish(Response.json(turn));
				};
			});
		}
		if (path === "/worker/result" && request.method === "POST") {
			const pending = this.#pending;
			if (!pending?.delivered || pending.signal.aborted)
				return new Response("No matching turn", { status: 409 });
			if (this.#receivingResult)
				return new Response("Already receiving", { status: 429 });
			this.#receivingResult = true;
			try {
				const value: unknown = JSON.parse(
					await boundedText(
						request.body,
						72 * 1024 * 1024,
						AbortSignal.any([request.signal, pending.signal]),
					),
				);
				if (
					!isRecord(value) ||
					this.#pending !== pending ||
					value.turnId !== pending.request.turnId ||
					!this.#pending?.delivered ||
					!isRecord(value.result) ||
					typeof value.result.ok !== "boolean"
				)
					return new Response("No matching turn", { status: 409 });
				const result = value.result;
				if (
					result.ok
						? typeof result.text !== "string" ||
							result.text.length > 100_000 ||
							!Array.isArray(result.files) ||
							result.files.length > PI_MEDIA_LIMITS.files
						: typeof result.error !== "string" || result.error.length > 10000
				)
					return new Response("Invalid result", { status: 400 });
				if (
					result.ok === true &&
					typeof result.text === "string" &&
					Array.isArray(result.files)
				) {
					validateReplyFiles(result.files);
					this.#pending.resolve({
						ok: true,
						text: result.text,
						files: result.files,
					});
				} else if (typeof result.error === "string")
					this.#pending.resolve({ ok: false, error: result.error });
				return new Response("Accepted");
			} catch {
				return new Response("Invalid result", { status: 400 });
			} finally {
				this.#receivingResult = false;
			}
		}
		return new Response("Not found", { status: 404 });
	}
	#turn:
		| { context: PiHostContext; remaining: number; active: number }
		| undefined;
	/**
	 * A restarted worker connects its MCP servers before any turn, so it needs the metadata-only
	 * window again. It still allows no tool call, and re-arming is rate-limited.
	 */
	#rearmStartup(): void {
		const startup = this.#startup;
		if (
			!this.#turn &&
			(!startup || startup.context.signal.aborted || startup.remaining <= 0) &&
			Date.now() - this.#startupArmed > 10_000
		)
			this.#startup = this.#newStartup();
	}
	#startupArmed = Date.now();
	#startup:
		| { context: PiHostContext; remaining: number; active: number }
		| undefined = this.#newStartup();
	#newStartup() {
		this.#startupArmed = Date.now();
		return {
			context: {
				channel: "sandbox:startup" as ChannelKey,
				profile: "",
				speaker: { id: "", name: "" },
				thinking: "low" as const,
				signal: AbortSignal.timeout(90_000),
			},
			remaining: 32,
			active: 0,
		};
	}
	constructor(options: PiBrokerOptions) {
		endpoint(options.upstream ?? "https://api.anthropic.com");
		for (const server of options.mcp?.servers ?? []) {
			endpoint(server.url, options.allowHttpMcp);
			if (!/^[a-zA-Z0-9_-]{1,100}$/.test(server.name))
				throw new Error("Invalid MCP server name");
		}
		if (
			!Number.isSafeInteger(options.maxCalls ?? 128) ||
			(options.maxCalls ?? 128) < 1 ||
			(options.maxCalls ?? 128) > 1000
		)
			throw new Error("Invalid broker budget");
		const compaction = options.compaction;
		if (
			compaction &&
			(!/^[a-zA-Z0-9@/._-]{1,100}$/.test(compaction.engine) ||
				!Number.isSafeInteger(
					compaction.timeoutMs ?? PI_COMPACT_LIMITS.timeoutMs,
				) ||
				(compaction.timeoutMs ?? PI_COMPACT_LIMITS.timeoutMs) < 1000 ||
				(compaction.timeoutMs ?? PI_COMPACT_LIMITS.timeoutMs) > 600_000 ||
				!Number.isSafeInteger(
					compaction.maxRequestBytes ?? PI_COMPACT_LIMITS.requestBytes,
				) ||
				(compaction.maxRequestBytes ?? PI_COMPACT_LIMITS.requestBytes) < 1 ||
				(compaction.maxRequestBytes ?? PI_COMPACT_LIMITS.requestBytes) >
					96 * 1024 * 1024)
		)
			throw new Error("Invalid compactor");
		if (
			!Number.isSafeInteger(options.maxOutputTokens ?? 128_000) ||
			(options.maxOutputTokens ?? 128_000) < 1025 ||
			(options.maxOutputTokens ?? 128_000) > 200_000
		)
			throw new Error("Invalid output-token budget");
		this.#options = options;
	}
	bind(context: PiHostContext): () => void {
		if (this.#turn) throw new Error("Broker turn already active");
		const bound = {
			context: { ...context, speaker: { ...context.speaker } },
			remaining: this.#options.maxCalls ?? 128,
			active: 0,
		};
		this.#startup = undefined;
		this.#turn = bound;
		return () => {
			if (this.#turn === bound) this.#turn = undefined;
		};
	}
	listen(socket: string): Promise<BrokerListener> {
		return listenBroker(socket, (request) => this.handle(request), {
			stream: true,
		});
	}
	async handle(request: Request): Promise<Response> {
		// pi-lens-ignore: unchecked-throwing-call -- Request construction already validates this absolute URL.
		const url = new URL(request.url);
		if (url.hash || (url.search && url.search !== "?beta=true"))
			return new Response("Not found", { status: 404 });
		if (url.pathname.startsWith("/worker/") && !url.search)
			return this.#worker(request, url.pathname);
		// Discovery is static and credential-free, needed before the worker's first admitted turn.
		if (
			url.pathname === "/mcp-tools" &&
			request.method === "GET" &&
			!url.search
		) {
			// The worker's first call after a restart, before it connects its MCP servers.
			this.#rearmStartup();
			return Response.json({
				servers: (this.#options.mcp?.servers ?? []).map(({ name, tools }) => ({
					name,
					tools,
				})),
			});
		}
		if (
			(url.pathname === "/compaction/compact" ||
				url.pathname === "/compaction/report") &&
			!url.search
		)
			return this.#compaction(request, url.pathname);
		const startup = !this.#turn;
		const turn = this.#turn ?? this.#startup;
		if (!turn || turn.context.signal.aborted)
			return new Response("Turn ended", { status: 410 });
		const toolName = url.pathname.startsWith("/tools/")
			? url.pathname.slice(7)
			: "";
		const server = url.pathname.startsWith("/mcp/")
			? this.#options.mcp?.servers.find((s) => s.name === url.pathname.slice(5))
			: undefined;
		const model = MODEL_PATHS.has(url.pathname);
		if (startup && !server) return new Response("Turn ended", { status: 410 });
		if (
			request.method !== "POST" ||
			(!model && !server && !this.#options.tools?.names.includes(toolName)) ||
			(!model && url.search)
		)
			return new Response("Not found", { status: 404 });
		if (turn.remaining <= 0 || turn.active >= 4)
			return new Response("Broker budget exhausted", { status: 429 });
		turn.remaining--;
		turn.active++;
		// The turn signal carries the deadline: a long generation or image call must not be cut shorter.
		const signal = AbortSignal.any([turn.context.signal, request.signal]);
		const failed = this.#failureLog(
			turn.context.channel,
			toolName ? `tool:${toolName}` : server ? `mcp:${server.name}` : "model",
		);
		let secret = "";
		try {
			const input: unknown = JSON.parse(
				await boundedText(request.body, 96 * 1024 * 1024),
			);
			if (!isRecord(input))
				return new Response("Invalid input", { status: 400 });
			signal.throwIfAborted();
			if (toolName) {
				if (!isRecord(input.input))
					return new Response("Invalid tool input", { status: 400 });
				// Deliberately ignore every caller identity field; the host-bound speaker wins.
				const result = await this.#options.tools?.call(toolName, input.input, {
					...turn.context,
					signal,
				});
				if (
					!result ||
					typeof result.ok !== "boolean" ||
					(result.text?.length ?? 0) > 1_000_000 ||
					(result.error?.length ?? 0) > 10_000 ||
					(result.privateTo !== undefined &&
						(typeof result.privateTo !== "string" ||
							result.privateTo.length === 0 ||
							result.privateTo.length > 256))
				)
					throw new Error("Invalid tool output");
				if (result.image) validateImages([result.image]);
				signal.throwIfAborted();
				return Response.json(result);
			}
			let target: string;
			let body: Record<string, unknown>;
			const headers = new Headers({
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"accept-encoding": "identity",
			});
			if (server) {
				const params = input.params;
				const allowed =
					input.method === "initialize" ||
					input.method === "notifications/initialized" ||
					input.method === "ping" ||
					input.method === "tools/list" ||
					(input.method === "tools/call" &&
						isRecord(params) &&
						typeof params.name === "string" &&
						server.tools.includes(params.name) &&
						isRecord(params.arguments));
				if (!allowed || (startup && input.method === "tools/call"))
					return new Response("MCP method refused", { status: 403 });
				target = server.url;
				secret = (await this.#options.mcp?.token()) ?? "";
				body = {
					jsonrpc: "2.0",
					...(input.id === undefined ? {} : { id: input.id }),
					method: input.method,
					...(params === undefined ? {} : { params }),
				};
				for (const name of ["mcp-session-id", "mcp-protocol-version"]) {
					const value = request.headers.get(name);
					if (value && value.length <= 256) headers.set(name, value);
				}
			} else {
				try {
					body = piModelInput(
						input,
						this.#options.model,
						url.pathname.endsWith("/count_tokens"),
						this.#options.maxOutputTokens ?? 128_000,
						turn.context.thinking,
					);
				} catch (error) {
					// The request itself is refused: a 400 the client does not retry unchanged, in the
					// API's error shape so it can resend without what was refused. A 502 would be retried.
					failed(secret, { status: 400, error });
					return Response.json(
						{
							type: "error",
							error: {
								type: "invalid_request_error",
								message: error instanceof Error ? error.message : String(error),
							},
						},
						{ status: 400 },
					);
				}
				target = `${this.#options.upstream ?? "https://api.anthropic.com"}${url.pathname.slice("/anthropic".length)}${url.search}`;
				const { channel, speaker } = turn.context;
				secret =
					(await this.#options.oauthToken({
						channel,
						speaker: { id: speaker.id, name: speaker.name },
					})) ?? "";
				for (const name of HEADERS) {
					const value = request.headers.get(name);
					if (value && value.length <= 4096) headers.set(name, value);
				}
			}
			if (!secret) throw new Error("Credential unavailable");
			headers.set("authorization", `Bearer ${secret}`);
			const upstream = await (this.#options.fetchImpl ?? fetch)(target, {
				method: "POST",
				redirect: "error",
				headers,
				body: JSON.stringify(body),
				signal,
			});
			// Errors keep their status, body and back-off headers so the worker can recognize an
			// oversized context, a rate limit or an expired MCP session; the same scans apply.
			const outgoing = new Headers();
			for (const [name, value] of upstream.headers) {
				if (
					passthroughHeader(name) &&
					value.length <= 256 &&
					!value.includes(secret)
				)
					outgoing.set(name, value);
			}
			if (server) {
				const id = upstream.headers.get("mcp-session-id");
				if (id && !id.includes(secret) && id.length <= 256)
					outgoing.set("mcp-session-id", id);
			}
			if (upstream.status < 200 || upstream.status > 599) {
				failed(secret, { status: upstream.status });
				return new Response("Upstream refused", { status: 502 });
			}
			let answer = upstream;
			if (upstream.status >= 400 && upstream.body) {
				// The log reads the error body's head from one branch; the worker gets all of it from the other.
				const [logged, sent] = upstream.body.tee();
				void bodyHead(logged, 64 * 1024).then((body) =>
					failed(secret, { status: upstream.status, body }),
				);
				answer = new Response(sent, { status: upstream.status });
			} else if (upstream.status >= 400)
				failed(secret, { status: upstream.status });
			return new Response(
				upstream.status === 204 || upstream.status === 205
					? null
					: streamBounded(
							answer,
							signal,
							PI_MEDIA_LIMITS.totalFileBytes,
							secret,
							(error) => failed(secret, { status: upstream.status, error }),
							upstream.status < 400 &&
								(upstream.headers.get("content-type") ?? "").includes(
									"text/event-stream",
								)
								? sseErrorWatcher((body) =>
										failed(secret, {
											status: upstream.status,
											body: `stream error event: ${body}`,
										}),
									)
								: undefined,
						),
				{ headers: outgoing, status: upstream.status },
			);
		} catch (error) {
			failed(secret, { error });
			return new Response("Broker call failed", { status: 502 });
		} finally {
			turn.active--;
		}
	}
	/** Logs a failed upstream call with its latency; the body and error lose any credential. */
	#failureLog(channel: ChannelKey, upstream: string) {
		const started = Date.now();
		return (
			secret: string,
			failure: { status?: number; body?: string; error?: unknown },
		): void => {
			const clean = (text: string) =>
				scrubDiagnostic(
					secretForms(secret).reduce(
						(masked, form) => masked.replaceAll(form, "[redacted]"),
						text,
					),
					2000,
				);
			this.#options.logger?.warn(
				{
					channel,
					upstream,
					...(failure.status === undefined ? {} : { status: failure.status }),
					latencyMs: Date.now() - started,
					...(failure.body === undefined ? {} : { body: clean(failure.body) }),
					...(failure.error === undefined
						? {}
						: { error: clean(errorText(failure.error)) }),
				},
				"sandbox upstream call failed",
			);
		};
	}
	/** Settles when the running compactor really ends, even after its request fell back. */
	#compacting: Promise<unknown> | undefined;
	readonly #compactionUse = new WeakMap<
		object,
		{ compacts: number; reports: number }
	>();
	/** The worker's compactions, only inside an admitted turn: a host compaction, or a report to log. */
	async #compaction(request: Request, path: string): Promise<Response> {
		const turn = this.#turn;
		if (request.method !== "POST")
			return new Response("Not found", { status: 404 });
		if (!turn || turn.context.signal.aborted)
			return new Response("Turn ended", { status: 410 });
		const { channel } = turn.context;
		const logger = this.#options.logger;
		const use = this.#compactionUse.get(turn) ?? { compacts: 0, reports: 0 };
		this.#compactionUse.set(turn, use);
		if (path === "/compaction/report") {
			// A turn compacts a few times at most; more reports only fill the host's log.
			if (++use.reports > PI_COMPACT_LIMITS.reportsPerTurn)
				return new Response("Report budget exhausted", { status: 429 });
			try {
				const report: unknown = JSON.parse(
					await boundedText(request.body, 64 * 1024, turn.context.signal),
				);
				validateCompactionReport(report);
				this.#logReport(channel, report);
				return new Response("Accepted");
			} catch {
				return new Response("Invalid report", { status: 400 });
			}
		}
		const compactor = this.#options.compaction;
		const fallback = (reason: string): Response => {
			logger?.warn(
				{ channel, engine: compactor?.engine, fallback: reason },
				"compaction falls back to Pi's summary",
			);
			return Response.json({
				ok: false,
				fallback: reason,
			} satisfies PiCompactResponse);
		};
		if (!compactor) return fallback("the host has no compactor");
		if (this.#compacting) return fallback("a compaction is already running");
		if (++use.compacts > PI_COMPACT_LIMITS.compactsPerTurn)
			return fallback(
				`the turn already asked for ${PI_COMPACT_LIMITS.compactsPerTurn} compactions`,
			);
		const maxBytes =
			compactor.maxRequestBytes ?? PI_COMPACT_LIMITS.requestBytes;
		if (Number(request.headers.get("content-length") ?? 0) > maxBytes)
			return fallback(`the request is over ${maxBytes} bytes`);
		// Pi's own summary must still fit after a compactor that runs out of time.
		const left =
			turn.context.deadline === undefined
				? Number.POSITIVE_INFINITY
				: turn.context.deadline - Date.now();
		const timeoutMs = Math.min(
			compactor.timeoutMs ?? PI_COMPACT_LIMITS.timeoutMs,
			Math.floor(left / 2),
		);
		if (timeoutMs < 1000)
			return fallback(
				"the turn has too little time left for the host compactor",
			);
		let running: Promise<unknown> = Promise.resolve();
		this.#compacting = running;
		const timeout = AbortSignal.timeout(timeoutMs);
		const signal = AbortSignal.any([
			turn.context.signal,
			request.signal,
			timeout,
		]);
		const started = Date.now();
		try {
			let compactRequest: unknown;
			try {
				compactRequest = JSON.parse(
					await boundedText(request.body, maxBytes, signal),
				);
				validateCompactRequest(compactRequest);
			} catch (error) {
				if (signal.aborted) throw error;
				return fallback(
					error instanceof Error && error.message === "body too large"
						? `the request is over ${maxBytes} bytes`
						: "the request is invalid",
				);
			}
			const compacting = compactor.compact(compactRequest, { channel, signal });
			running = compacting.catch(() => {});
			this.#compacting = running;
			const result = await abortableCompact(compacting, signal);
			if (!result) return fallback("the compactor declined");
			const details =
				result.details === undefined
					? { engine: compactor.engine }
					: isRecord(result.details)
						? { ...result.details, engine: compactor.engine }
						: undefined;
			if (
				!details ||
				typeof result.summary !== "string" ||
				result.summary.length === 0 ||
				result.firstKeptEntryId !== compactRequest.firstKeptEntryId ||
				!Number.isSafeInteger(result.tokensBefore) ||
				(result.estimatedTokensAfter !== undefined &&
					!Number.isSafeInteger(result.estimatedTokensAfter))
			)
				return fallback("the compactor's result is invalid");
			logger?.info(
				{
					channel,
					engine: compactor.engine,
					tokensBefore: result.tokensBefore,
					tokensAfter: result.estimatedTokensAfter,
					latencyMs: Date.now() - started,
				},
				"host compactor answered",
			);
			return Response.json({
				ok: true,
				compaction: {
					summary: result.summary,
					firstKeptEntryId: result.firstKeptEntryId,
					tokensBefore: result.tokensBefore,
					...(result.estimatedTokensAfter === undefined
						? {}
						: { estimatedTokensAfter: result.estimatedTokensAfter }),
					details,
				},
			} satisfies PiCompactResponse);
		} catch (error) {
			return fallback(
				timeout.aborted
					? `the compactor took over ${timeoutMs} ms`
					: signal.aborted
						? "the compaction was aborted"
						: `the compactor failed: ${scrubDiagnostic(errorText(error), 2000)}`,
			);
		} finally {
			// A compactor that ignored its signal still holds the slot until it really ends.
			void running.then(() => {
				if (this.#compacting === running) this.#compacting = undefined;
			});
		}
	}
	/** Logs a worker compaction the way the host logs its own sessions' compactions. */
	#logReport(channel: ChannelKey, report: PiCompactionReport): void {
		const logger = this.#options.logger;
		if (report.type === "bypass") {
			logger?.info(
				{
					channel,
					reason: report.reason,
					tokensBefore: report.tokensBefore,
					ceiling: HARD_COMPACT_TOKENS,
				},
				"compaction skips the extension for Pi's summary",
			);
			return;
		}
		const trigger = report.reason === "manual" ? "self" : report.reason;
		if (!report.engine) {
			logger?.warn(
				{ channel, trigger, aborted: report.aborted, error: report.error },
				"compaction failed",
			);
			return;
		}
		logger?.info(
			{
				channel,
				trigger,
				engine: report.engine,
				tokensBefore: report.tokensBefore,
				tokensAfter: report.tokensAfter,
				nextCompactionAt: report.nextCompactionAt,
			},
			"conversation compacted",
		);
	}
}
