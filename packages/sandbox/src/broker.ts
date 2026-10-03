import { chmodSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { Readable } from "node:stream";
import type { ChannelKey } from "pi-roundtable";
import { modelInput } from "./model-input.ts";
import {
	boundedText,
	DUMMY_KEY,
	isRecord,
	type ToolSpec,
	validName,
} from "./protocol.ts";

export interface BrokerListener {
	stop(force?: boolean): Promise<void>;
}

export interface HostToolContext {
	channel: ChannelKey;
	speaker: { id: string; name: string };
	signal: AbortSignal;
}
export interface HostTool extends ToolSpec {
	run(
		input: Record<string, unknown>,
		context: HostToolContext,
	): Promise<string> | string;
}
export interface McpServer {
	name: string;
	/** A trusted, fixed stateless Streamable HTTP endpoint returning JSON. */
	url: string;
	apiKey?: () => Promise<string | undefined> | string | undefined;
	tools: ToolSpec[];
}
export interface BrokerOptions {
	context: HostToolContext;
	model: string;
	/** Fixed complete URL, not a guest-selected base URL. */
	modelUrl: string;
	apiKey: () => Promise<string | undefined> | string | undefined;
	tools?: readonly HostTool[];
	mcp?: readonly McpServer[];
	/** Allow cleartext endpoints only for local testing. */
	allowHttp?: boolean;
	fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
	maxCalls?: number;
	maxOutputTokens?: number;
}

const FORBIDDEN_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"x-api-key",
	"cookie",
	"forwarded",
	"x-forwarded-host",
	"x-forwarded-for",
	"x-forwarded-proto",
]);

function checkUrl(raw: string, allowHttp: boolean): void {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("invalid broker endpoint URL");
	}
	if (
		(!allowHttp && url.protocol !== "https:") ||
		(allowHttp && !["http:", "https:"].includes(url.protocol)) ||
		url.username ||
		url.password ||
		url.hash
	)
		throw new Error("broker endpoints must be credential-free HTTPS URLs");
}

/** A per-turn capability boundary: the host, not the guest, supplies the channel and speaker. */
export class SandboxBroker {
	readonly #options: BrokerOptions;
	readonly #tools: Map<string, HostTool>;
	readonly #mcp: Map<string, McpServer>;
	#remaining: number;
	#active = false;

	constructor(options: BrokerOptions) {
		checkUrl(options.modelUrl, options.allowHttp ?? false);
		this.#options = options;
		this.#remaining = options.maxCalls ?? 48;
		if (
			!Number.isSafeInteger(this.#remaining) ||
			this.#remaining < 1 ||
			this.#remaining > 1000 ||
			!Number.isSafeInteger(options.maxOutputTokens ?? 4096) ||
			(options.maxOutputTokens ?? 4096) < 1 ||
			(options.maxOutputTokens ?? 4096) > 32768
		)
			throw new Error("invalid broker call or output-token budget");
		this.#tools = new Map();
		this.#mcp = new Map();
		for (const tool of options.tools ?? []) {
			if (!validName(tool.name) || this.#tools.has(tool.name))
				throw new Error("invalid or duplicate host tool");
			this.#tools.set(tool.name, tool);
		}
		for (const server of options.mcp ?? []) {
			checkUrl(server.url, options.allowHttp ?? false);
			if (
				!validName(server.name) ||
				this.#mcp.has(server.name) ||
				new Set(server.tools.map((tool) => tool.name)).size !==
					server.tools.length ||
				server.tools.some((tool) => !validName(tool.name))
			)
				throw new Error("invalid or duplicate MCP server/tool");
			this.#mcp.set(server.name, server);
		}
	}

	/** This handler can be exercised offline, without binding a socket or using Docker. */
	async handle(request: Request): Promise<Response> {
		let url: URL;
		try {
			url = new URL(request.url);
		} catch {
			return new Response("invalid URL", { status: 400 });
		}
		if (request.method !== "POST" || url.search || url.hash)
			return new Response("not found", { status: 404 });
		const permittedHeaders = new Set([
			"host",
			"content-type",
			"content-length",
			"accept",
			"accept-encoding",
			"authorization",
			"user-agent",
		]);
		for (const [name] of request.headers) {
			if (FORBIDDEN_HEADERS.has(name) || !permittedHeaders.has(name))
				return new Response("forbidden header", { status: 403 });
		}
		const auth = request.headers.get("authorization");
		if (auth !== null && auth !== `Bearer ${DUMMY_KEY}`)
			return new Response("forbidden credential", { status: 403 });
		const host = request.headers.get("host");
		if (host !== null && host !== "broker")
			return new Response("forbidden host", { status: 403 });
		const tool = url.pathname.startsWith("/tools/")
			? this.#tools.get(url.pathname.slice(7))
			: undefined;
		const server = url.pathname.startsWith("/mcp/")
			? this.#mcp.get(url.pathname.slice(5))
			: undefined;
		if (url.pathname !== "/model" && !tool && !server)
			return new Response("not found", { status: 404 });
		if (this.#options.context.signal.aborted)
			return new Response("turn ended", { status: 410 });
		if (this.#active || this.#remaining <= 0)
			return new Response("call budget exhausted or busy", { status: 429 });
		this.#active = true;
		this.#remaining--;
		const signal = AbortSignal.any([
			this.#options.context.signal,
			request.signal,
			AbortSignal.timeout(60_000),
		]);
		try {
			const body: unknown = JSON.parse(
				await boundedText(request.body, 256 * 1024),
			);
			if (!isRecord(body))
				return new Response("invalid input", { status: 400 });
			signal.throwIfAborted();
			if (tool) {
				const result = await tool.run(body, {
					...this.#options.context,
					signal,
				});
				if (
					typeof result !== "string" ||
					Buffer.byteLength(JSON.stringify({ text: result })) > 1024 * 1024
				)
					throw new Error("invalid tool result");
				return Response.json({ text: result });
			}
			if (server) {
				const params = body.params;
				if (
					body.method !== "tools/call" ||
					!isRecord(params) ||
					typeof params.name !== "string" ||
					!server.tools.some((entry) => entry.name === params.name) ||
					!isRecord(params.arguments)
				)
					return new Response("MCP method or tool refused", { status: 403 });
				return await this.#forward(
					server.url,
					await server.apiKey?.(),
					{
						jsonrpc: "2.0",
						id: 1,
						method: "tools/call",
						params: { name: params.name, arguments: params.arguments },
					},
					signal,
				);
			}
			const normalized = modelInput(body);
			if (!normalized)
				return new Response("text/function model payload required", {
					status: 400,
				});
			const key = await this.#options.apiKey();
			if (!key) throw new Error("model credential unavailable");
			return await this.#forward(
				this.#options.modelUrl,
				key,
				{
					model: this.#options.model,
					...normalized,
					stream: false,
					max_tokens: this.#options.maxOutputTokens ?? 4096,
				},
				signal,
			);
		} catch {
			// Never expose errors containing upstream URLs, headers, credentials or tool internals.
			return new Response("broker call failed", { status: 502 });
		} finally {
			this.#active = false;
		}
	}

	async #forward(
		url: string,
		key: string | undefined,
		body: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<Response> {
		const response = await (this.#options.fetchImpl ?? fetch)(url, {
			method: "POST",
			redirect: "error",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
				...(key ? { authorization: `Bearer ${key}` } : {}),
			},
			body: JSON.stringify(body),
			signal,
		});
		if (!response.ok) throw new Error("upstream refused");
		const text = await boundedText(response.body, 1024 * 1024);
		// Only JSON bodies leave the broker; no upstream headers, cookies or redirects do.
		// A trusted upstream must not reflect secrets in its data either.
		let payload: unknown;
		try {
			payload = JSON.parse(text);
		} catch {
			throw new Error("upstream returned invalid JSON");
		}
		const secrets = key
			? [
					key,
					encodeURIComponent(key),
					Buffer.from(key).toString("base64"),
					Buffer.from(key).toString("base64url"),
					Buffer.from(key).toString("hex"),
					Buffer.from(key).toString("hex").toUpperCase(),
				]
			: [];
		const reflected = (value: unknown): boolean => {
			if (typeof value === "string")
				return secrets.some((secret) => value.includes(secret));
			if (Array.isArray(value)) return value.some(reflected);
			if (isRecord(value))
				return Object.entries(value).some(
					([name, entry]) => reflected(name) || reflected(entry),
				);
			return false;
		};
		if (reflected(payload)) throw new Error("credential reflected");
		return Response.json(payload);
	}

	async listen(socketPath: string): Promise<BrokerListener> {
		return listenBroker(socketPath, (request) => this.handle(request));
	}
}

export interface ListenOptions {
	/**
	 * Stream the response with backpressure instead of buffering it. Time is then bounded by
	 * the host's own signal in `handle` plus an idle limit on each body read and write.
	 */
	stream?: boolean;
	/** Idle limit between body chunks in stream mode. Default 120 000 ms. */
	idleMs?: number;
}

export async function listenBroker(
	socketPath: string,
	handle: (request: Request) => Promise<Response>,
	options: ListenOptions = {},
): Promise<BrokerListener> {
	const stream = options.stream === true;
	const idleMs = options.idleMs ?? 120_000;
	const sockets = new Set<Socket>();
	const headerTimers = new Map<Socket, ReturnType<typeof setTimeout>>();
	const server = createServer(async (incoming, outgoing) => {
		clearTimeout(headerTimers.get(incoming.socket));
		headerTimers.delete(incoming.socket);
		const requestController = new AbortController();
		const expire = () => {
			requestController.abort();
			incoming.destroy();
			outgoing.destroy();
		};
		let requestTimer = setTimeout(expire, stream ? idleMs : 60_000);
		// Stream mode only limits silence: slow progress is allowed, a stalled peer is not.
		const touch = () => {
			if (!stream) return;
			clearTimeout(requestTimer);
			requestTimer = setTimeout(expire, idleMs);
		};
		const finish = () => {
			clearTimeout(requestTimer);
			requestController.abort();
		};
		if (stream) {
			incoming.on("data", touch);
			// The host handler may take as long as its own signal allows; only body silence is limited.
			incoming.once("end", () => clearTimeout(requestTimer));
			if (incoming.method === "GET" || incoming.method === "HEAD")
				clearTimeout(requestTimer);
		}
		outgoing.once("finish", finish);
		outgoing.once("close", finish);
		outgoing.on("error", () => outgoing.destroy());
		outgoing.setHeader("connection", "close");
		try {
			const headers = new Headers();
			for (const [name, value] of Object.entries(incoming.headers)) {
				if (value !== undefined)
					headers.set(name, Array.isArray(value) ? value.join(", ") : value);
			}
			const request = new Request(`http://broker${incoming.url ?? "/"}`, {
				method: incoming.method ?? "GET",
				headers,
				signal: requestController.signal,
				...(incoming.method === "GET" || incoming.method === "HEAD"
					? {}
					: { body: Readable.toWeb(incoming), duplex: "half" }),
			});
			const response = await handle(request);
			if (stream) {
				if (outgoing.destroyed || outgoing.writableEnded) {
					await response.body?.cancel();
					return;
				}
				outgoing.writeHead(
					response.status,
					Object.fromEntries(response.headers),
				);
				touch();
				const reader = response.body?.getReader();
				outgoing.once("close", () => void reader?.cancel().catch(() => {}));
				for (;;) {
					const chunk = await reader?.read();
					if (!chunk || chunk.done) break;
					touch();
					if (outgoing.destroyed) break;
					if (!outgoing.write(chunk.value))
						await new Promise<void>((resolve) => {
							const done = () => {
								outgoing.off("drain", done);
								outgoing.off("close", done);
								resolve();
							};
							outgoing.once("drain", done);
							outgoing.once("close", done);
						});
				}
				if (!outgoing.destroyed) outgoing.end();
				return;
			}
			const bytes = Buffer.from(await response.arrayBuffer());
			if (!outgoing.destroyed && !outgoing.writableEnded) {
				outgoing.writeHead(
					response.status,
					Object.fromEntries(response.headers),
				);
				outgoing.end(bytes);
			}
		} catch {
			if (outgoing.headersSent) outgoing.destroy();
			else if (!outgoing.destroyed && !outgoing.writableEnded) {
				outgoing.writeHead(400);
				outgoing.end("bad request");
			}
		}
	});
	server.on("connection", (socket) => {
		if (sockets.size >= 16) {
			socket.destroy();
			return;
		}
		sockets.add(socket);
		headerTimers.set(
			socket,
			setTimeout(() => socket.destroy(), 10_000),
		);
		socket.once("close", () => {
			sockets.delete(socket);
			clearTimeout(headerTimers.get(socket));
			headerTimers.delete(socket);
		});
	});
	server.maxConnections = 16;
	server.headersTimeout = 10_000;
	server.requestTimeout = stream ? 0 : 60_000;
	server.keepAliveTimeout = 1000;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	try {
		chmodSync(socketPath, 0o600);
	} catch (error) {
		for (const socket of sockets) socket.destroy();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		throw error;
	}
	return {
		stop: (force = true) =>
			new Promise<void>((resolve) => {
				if (force) {
					for (const socket of sockets) socket.destroy();
					server.closeAllConnections();
				}
				server.close(() => resolve());
			}),
	};
}
