import type { ChannelKey } from "pi-roundtable";
import { type BrokerListener, listenBroker } from "./broker.ts";
import { piModelInput } from "./pi-model-input.ts";
import {
	PI_MEDIA_LIMITS,
	type PiThinkingLevel,
	type PiToolResponse,
	type PiTurnRequest,
	type PiTurnResponse,
	validateImages,
	validateReplyFiles,
} from "./pi-protocol.ts";
import { boundedText, isRecord } from "./protocol.ts";

export interface PiHostContext {
	channel: ChannelKey;
	profile: string;
	speaker: { id: string; name: string };
	/** The host-judged level for this turn; the worker can request less but never more. */
	thinking: PiThinkingLevel;
	signal: AbortSignal;
}
export interface PiMcpServer {
	name: string;
	url: string;
	tools: readonly string[];
}
export interface PiBrokerOptions {
	model: string;
	/** Host-only, read at each call. Never sent to the worker. */
	oauthToken: () => string | Promise<string>;
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
function streamBounded(
	response: Response,
	signal: AbortSignal,
	maxBytes: number,
	secret: string,
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
				if (!result || result.done) {
					if (data.length) controller.enqueue(data);
					controller.close();
					return;
				}
				const cut = Math.max(0, data.length - tail);
				if (cut) controller.enqueue(data.subarray(0, cut));
				carry = data.subarray(cut);
			} catch {
				await reader?.cancel().catch(() => {});
				controller.error(new Error("Broker response failed"));
			}
		},
		cancel: () => reader?.cancel(),
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
					(result.error?.length ?? 0) > 10_000
				)
					throw new Error("Invalid tool output");
				if (result.image) validateImages([result.image]);
				signal.throwIfAborted();
				return Response.json(result);
			}
			let target: string;
			let secret: string;
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
				body = piModelInput(
					input,
					this.#options.model,
					url.pathname.endsWith("/count_tokens"),
					this.#options.maxOutputTokens ?? 128_000,
					turn.context.thinking,
				);
				target = `${this.#options.upstream ?? "https://api.anthropic.com"}${url.pathname.slice("/anthropic".length)}${url.search}`;
				secret = await this.#options.oauthToken();
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
			if (upstream.status < 200 || upstream.status > 599)
				return new Response("Upstream refused", { status: 502 });
			return new Response(
				upstream.status === 204 || upstream.status === 205
					? null
					: streamBounded(
							upstream,
							signal,
							PI_MEDIA_LIMITS.totalFileBytes,
							secret,
						),
				{ headers: outgoing, status: upstream.status },
			);
		} catch {
			return new Response("Broker call failed", { status: 502 });
		} finally {
			turn.active--;
		}
	}
}
