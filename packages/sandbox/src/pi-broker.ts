import type { ChannelKey } from "pi-roundtable";
import { type BrokerListener, listenBroker } from "./broker.ts";
import { BrokerCompaction } from "./pi-broker-compaction.ts";
import {
	type PiBrokerOptions,
	type PiHostContext,
	validateBrokerOptions,
} from "./pi-broker-options.ts";
import { failureLog, forwardUpstream } from "./pi-broker-upstream.ts";
import { piModelInput } from "./pi-model-input.ts";
import {
	PI_MEDIA_LIMITS,
	type PiTurnRequest,
	type PiTurnResponse,
	type PiWorkerConfig,
	type PiWorkerReady,
	validateImages,
	validateReplyFiles,
} from "./pi-protocol.ts";
import { boundedText, isRecord } from "./protocol.ts";

export {
	PI_COMPACT_LIMITS,
	type PiBrokerOptions,
	type PiCompactor,
	type PiHostContext,
	type PiMcpServer,
} from "./pi-broker-options.ts";
export { errorText } from "./pi-broker-upstream.ts";

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
/** Explicit subscription mode. A broker is idle except while the host binds one admitted turn. */
export class PiSandboxBroker {
	readonly #options: PiBrokerOptions;
	readonly #compaction: BrokerCompaction;
	#ready = false;
	#capabilities: NonNullable<PiWorkerReady["capabilities"]> = {};
	#requiresPrivacy = false;
	#capabilityProblem(): string | undefined {
		const missing = (["privateTo", "readerRecords"] as const).filter(
			(name) => this.#capabilities[name] !== true,
		);
		return missing.length === 0
			? undefined
			: `Sandbox worker image ${this.#options.workerImage ?? "(configured image)"} lacks ${missing.join(", ")}; rebuild this image with the installed core and sandbox packages`;
	}
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
		const privatePrompt =
			request.memory.length > 0 && request.memoryVisibility !== "shared";
		if (this.#requiresPrivacy || privatePrompt) {
			const problem = this.#capabilityProblem();
			if (problem) return Promise.reject(new Error(problem));
			this.#requiresPrivacy = true;
		}
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
				reject: (error) => {
					signal.removeEventListener("abort", abort);
					this.#pending = undefined;
					reject(error);
				},
			};
			this.#next?.(request);
		});
	}
	async #worker(request: Request, path: string): Promise<Response> {
		if (path === "/worker/ready" && request.method === "POST") {
			try {
				const text = await boundedText(request.body, 16_384, request.signal);
				const value: unknown = text.trim() ? JSON.parse(text) : {};
				if (
					!isRecord(value) ||
					(value.privateHistory !== undefined &&
						typeof value.privateHistory !== "boolean")
				)
					throw new Error("Invalid ready handshake");
				const caps = value.capabilities;
				if (
					caps !== undefined &&
					(!isRecord(caps) ||
						[caps.privateTo, caps.readerRecords].some(
							(flag) => flag !== undefined && typeof flag !== "boolean",
						))
				)
					throw new Error("Invalid capabilities");
				this.#capabilities = isRecord(caps)
					? {
							privateTo: caps.privateTo === true,
							readerRecords: caps.readerRecords === true,
						}
					: {};
				if (value.privateHistory === true) this.#requiresPrivacy = true;
				if (this.#requiresPrivacy && this.#pending) {
					const problem = this.#capabilityProblem();
					if (problem) {
						if (this.#turn) this.#turn.failed = true;
						this.#pending.reject(new Error(problem));
					}
				}
			} catch {
				return new Response("Invalid ready handshake", { status: 400 });
			}
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
		| {
				context: PiHostContext;
				remaining: number;
				active: number;
				failed?: boolean;
		  }
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
		validateBrokerOptions(options);
		this.#options = options;
		this.#compaction = new BrokerCompaction(options);
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
			return this.#compaction.handle(request, url.pathname, this.#turn);
		const startup = !this.#turn;
		const turn = this.#turn ?? this.#startup;
		if (
			!turn ||
			turn.context.signal.aborted ||
			("failed" in turn && turn.failed)
		)
			return new Response("Turn ended", { status: 410 });
		if (this.#requiresPrivacy) {
			const problem = this.#capabilityProblem();
			if (problem) {
				if (this.#turn) this.#turn.failed = true;
				this.#pending?.reject(new Error(problem));
				return new Response(problem, { status: 410 });
			}
		}
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
		const failed = failureLog(
			this.#options.logger,
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
				if (result.privateTo !== undefined) {
					this.#requiresPrivacy = true;
					const problem = this.#capabilityProblem();
					if (problem) {
						// Do not release private bytes to an old worker, even when it catches tool errors.
						if (this.#turn === turn) {
							this.#turn.failed = true;
							this.#pending?.reject(new Error(problem));
						}
						return new Response(problem, { status: 409 });
					}
				}
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
			return await forwardUpstream({
				fetchImpl: this.#options.fetchImpl ?? fetch,
				target,
				headers,
				body,
				signal,
				secret,
				isMcp: server !== undefined,
				failed,
			});
		} catch (error) {
			failed(secret, { error });
			return new Response("Broker call failed", { status: 502 });
		} finally {
			turn.active--;
		}
	}
}
