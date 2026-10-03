import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
	PrecheckResult,
	PrecheckScope,
	PrecheckScriptContext,
	PrecheckScriptRunner,
} from "pi-roundtable";
import { listenBroker } from "./broker.ts";
import {
	type ContainerSpec,
	DockerContainerDriver,
} from "./container-driver.ts";
import { boundedText, DUMMY_KEY, isRecord } from "./protocol.ts";

/** An MCP server a precheck script may call, with only the listed tools. */
export interface PrecheckMcpServer {
	/** What the script calls it by, `mcp.call(name, tool, args)`: letters, digits, `_`, `-`. */
	name: string;
	/** A fixed Streamable HTTP endpoint answering a single `tools/call` with JSON or one SSE event. */
	url: string;
	/** The tools the script may call; every other method and tool is refused. */
	tools: readonly string[];
	/** The bearer credential, read on each call on the host; never sent to the container. */
	token?: () => string | undefined | Promise<string | undefined>;
}

/** Runs one sealed container: its stdin is `input`, and its bounded stdout comes back. */
export interface PrecheckContainerDriver {
	exec(
		spec: ContainerSpec,
		input: string,
		signal: AbortSignal,
		limits: { stdoutBytes: number },
	): Promise<string>;
}

export interface PrecheckScriptRunnerOptions {
	/** An image with Bun and this package installed, such as the Pi sandbox image. */
	image: string;
	/** A dedicated, short host directory for each run's broker socket and empty workspace. */
	runRoot: string;
	/** The non-root host user the container runs as; it owns `runRoot`. */
	uid: number;
	gid: number;
	/**
	 * The MCP servers and tools a script for this scope may call: never more than the schedule's
	 * agent can use itself. An empty list leaves the script no way out of its container.
	 */
	grant(
		scope: PrecheckScope,
	): readonly PrecheckMcpServer[] | Promise<readonly PrecheckMcpServer[]>;
	/** The container's command; default the package's worker in the Pi image's layout. */
	entrypoint?: readonly string[];
	/** How long a script may run; default 60 seconds. */
	timeoutMs?: number;
	/** MCP calls one run may make, refused ones included; default 16. */
	maxCalls?: number;
	/** Allow cleartext MCP endpoints, for a server on the same host only. */
	allowHttpMcp?: boolean;
	/** The container's limits; default 256 MiB, one CPU, 32 processes. */
	limits?: { memoryMb?: number; cpus?: number; pids?: number };
	/** Replaceable in tests. */
	driver?: PrecheckContainerDriver;
	fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

/** Where the Pi sandbox image keeps this package's worker. */
export const PRECHECK_ENTRYPOINT = Object.freeze([
	"bun",
	"/app/node_modules/pi-roundtable-sandbox/worker/precheck-main.ts",
]);

/** What the worker reads on its stdin. */
export interface PrecheckWorkerInput {
	script: string;
	firedAt: string;
	timeZone: string;
	today: string;
	schedule: { id: number; title: string };
	servers: { name: string; tools: string[] }[];
}

const SERVER_NAME = /^[a-zA-Z0-9_-]{1,100}$/;
const RESPONSE_BYTES = 1024 * 1024;

function checkServers(
	servers: readonly PrecheckMcpServer[],
	allowHttp: boolean,
): void {
	const names = new Set<string>();
	for (const server of servers) {
		if (!SERVER_NAME.test(server.name) || names.has(server.name))
			throw new Error("invalid or repeated precheck MCP server name");
		names.add(server.name);
		let url: URL;
		try {
			url = new URL(server.url);
		} catch {
			throw new Error("invalid precheck MCP endpoint");
		}
		if (
			!(url.protocol === "https:" || (allowHttp && url.protocol === "http:")) ||
			url.username ||
			url.password ||
			url.hash
		)
			throw new Error("precheck MCP endpoints must be credential-free HTTPS");
		if (
			!Array.isArray(server.tools) ||
			server.tools.some(
				(tool) => typeof tool !== "string" || !/^[\w.-]{1,128}$/.test(tool),
			)
		)
			throw new Error("invalid precheck MCP tool list");
	}
}

/**
 * Whether a parsed answer carries the credential: in any key or string, also inside a string
 * holding JSON (as MCP text content does), plainly or base64-encoded. This catches an upstream
 * that echoes the credential; the grant must still name only upstreams the host trusts.
 */
function carries(value: unknown, secret: string, depth = 0): boolean {
	if (depth > 64) return true;
	const forms = [
		secret,
		Buffer.from(secret).toString("base64"),
		Buffer.from(secret).toString("base64url"),
	];
	if (typeof value === "string") {
		if (forms.some((form) => value.includes(form))) return true;
		const trimmed = value.trim();
		if (!/^[[{"]/.test(trimmed)) return false;
		try {
			return carries(JSON.parse(trimmed), secret, depth + 1);
		} catch {
			return false;
		}
	}
	if (Array.isArray(value))
		return value.some((item) => carries(item, secret, depth + 1));
	if (isRecord(value))
		return Object.entries(value).some(
			([key, item]) =>
				forms.some((form) => key.includes(form)) ||
				carries(item, secret, depth + 1),
		);
	return false;
}

/** The JSON-RPC message of an answer: the body, or an SSE answer's last `data:` event that parses. */
function jsonRpcMessage(
	text: string,
	eventStream: boolean,
): Record<string, unknown> | undefined {
	const parsed = (raw: string): Record<string, unknown> | undefined => {
		try {
			const value: unknown = JSON.parse(raw);
			return isRecord(value) ? value : undefined;
		} catch {
			return undefined;
		}
	};
	if (!eventStream) return parsed(text);
	// An event's `data:` lines join with newlines; a blank line ends the event.
	let found: Record<string, unknown> | undefined;
	let data: string[] = [];
	for (const line of [...text.split(/\r?\n/), ""]) {
		if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
		else if (line === "" && data.length) {
			found = parsed(data.join("\n")) ?? found;
			data = [];
		}
	}
	return found;
}

/**
 * The broker of one precheck run: only `POST /mcp/<server>` with a single `tools/call` of a
 * granted tool, within the call budget. The host inserts the credential and checks nothing of
 * it comes back.
 */
export function precheckBroker(options: {
	servers: readonly PrecheckMcpServer[];
	signal: AbortSignal;
	maxCalls: number;
	fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}): (request: Request) => Promise<Response> {
	let remaining = options.maxCalls;
	let active = false;
	return async (request) => {
		let url: URL;
		try {
			url = new URL(request.url);
		} catch {
			return new Response("invalid URL", { status: 400 });
		}
		const server = url.pathname.startsWith("/mcp/")
			? options.servers.find((s) => s.name === url.pathname.slice(5))
			: undefined;
		const auth = request.headers.get("authorization");
		if (
			request.method !== "POST" ||
			url.search ||
			!server ||
			(auth !== null && auth !== `Bearer ${DUMMY_KEY}`)
		)
			return new Response("not found", { status: 404 });
		if (options.signal.aborted)
			return new Response("run ended", { status: 410 });
		if (active) return new Response("one call at a time", { status: 409 });
		if (remaining <= 0)
			return new Response("call budget exhausted", { status: 429 });
		active = true;
		remaining--;
		let secret = "";
		try {
			const body: unknown = JSON.parse(
				await boundedText(request.body, 64 * 1024),
			);
			const params = isRecord(body) ? body.params : undefined;
			if (
				!isRecord(body) ||
				body.method !== "tools/call" ||
				!isRecord(params) ||
				typeof params.name !== "string" ||
				!server.tools.includes(params.name) ||
				!(params.arguments === undefined || isRecord(params.arguments))
			)
				return new Response("MCP method or tool refused", { status: 403 });
			secret = (await server.token?.()) ?? "";
			const upstream = await (options.fetchImpl ?? fetch)(server.url, {
				method: "POST",
				redirect: "error",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					...(secret ? { authorization: `Bearer ${secret}` } : {}),
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: params.name, arguments: params.arguments ?? {} },
				}),
				signal: AbortSignal.any([options.signal, request.signal]),
			});
			const text = await boundedText(upstream.body, RESPONSE_BYTES);
			if (!upstream.ok)
				return new Response("upstream refused", { status: 502 });
			if (secret && text.includes(secret))
				return new Response("credential reflected", { status: 502 });
			const message = jsonRpcMessage(
				text,
				(upstream.headers.get("content-type") ?? "").includes(
					"text/event-stream",
				),
			);
			if (!message)
				return new Response("upstream returned no JSON-RPC message", {
					status: 502,
				});
			if (secret && carries(message, secret))
				return new Response("credential reflected", { status: 502 });
			// Only the JSON-RPC message leaves: no upstream headers, cookies, or redirects.
			return Response.json(message);
		} catch {
			// Never expose upstream URLs, headers, credentials, or exception text.
			return new Response("broker call failed", { status: 502 });
		} finally {
			active = false;
		}
	};
}

/** What a script for a scope is told: the contract, and the servers and tools it may call. */
function guide(servers: readonly PrecheckMcpServer[]): string {
	const reach =
		servers.length === 0
			? "Scripts for this schedule can call no MCP server, so they can only decide from the date and time."
			: `Scripts for this schedule may call only these MCP servers and tools:\n${servers.map((s) => `- ${s.name}: ${s.tools.join(", ")}`).join("\n")}`;
	return [
		"Write `export default async ({ mcp, firedAt, timeZone, today, schedule }) => result`.",
		"`result` is `{ wake: false, note? }` to skip the turn (the note, if any, is posted in small text) or `{ wake: true, context }` to wake you with `context`. Anything else, a throw, or running too long wakes you with the error.",
		"`today` is the date in the host's time zone (YYYY-MM-DD); pass it to tools instead of computing dates in UTC. `firedAt` is a Date and `timeZone` an IANA zone.",
		"Await each call before making the next; calls do not run in parallel. console output is discarded; only the returned result counts.",
		"`await mcp.call(server, tool, args)` returns the MCP tool result; `await mcp.json(server, tool, args)` returns its structured content, or its first text content parsed as JSON. A tool error throws.",
		"The script runs in a container with no network, no files of the host, and no credentials; it reaches only the tools below.",
		reach,
	].join("\n");
}

/**
 * Runs agents' precheck scripts in a sealed container, one per run: no network, a read-only
 * root, all capabilities dropped, a non-root user, and an empty workspace. Its only way out is a
 * per-run broker that forwards `tools/call` of the tools `grant` allows. Register it with
 * `services.get(PRECHECKS).useScriptRunner(precheckScriptRunner({ ... }))`.
 */
export function precheckScriptRunner(
	options: PrecheckScriptRunnerOptions,
): PrecheckScriptRunner {
	const driver = options.driver ?? new DockerContainerDriver();
	const maxCalls = options.maxCalls ?? 16;
	if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 100)
		throw new Error("invalid precheck MCP call budget");
	const grant = async (scope: PrecheckScope) => {
		const servers = await options.grant(scope);
		checkServers(servers, options.allowHttpMcp ?? false);
		return servers;
	};
	return {
		...(options.timeoutMs === undefined
			? {}
			: { timeoutMs: options.timeoutMs }),
		describe: async (scope) => guide(await grant(scope)),
		run: async (script, context) => runOne(script, context),
	};

	async function runOne(
		script: string,
		context: PrecheckScriptContext,
	): Promise<PrecheckResult> {
		const { schedule, signal } = context;
		const servers = await grant({
			channel: schedule.channel,
			target: schedule.target,
			tier: schedule.createdTier,
		});
		const dirs: string[] = [];
		let listener: Awaited<ReturnType<typeof listenBroker>> | undefined;
		try {
			const runDir = mkdtempSync(join(options.runRoot, "precheck-"));
			dirs.push(runDir);
			// Mounted read-only and left empty: a script can write only its container's bounded /tmp.
			const workspaceDir = mkdtempSync(join(options.runRoot, "precheck-ws-"));
			dirs.push(workspaceDir);
			const socket = join(runDir, "broker.sock");
			if (socket.length > 100) throw new Error("broker socket path too long");
			listener = await listenBroker(
				socket,
				precheckBroker({
					servers,
					signal,
					maxCalls,
					...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
				}),
			);
			const input: PrecheckWorkerInput = {
				script,
				firedAt: context.firedAt.toISOString(),
				timeZone: context.timeZone,
				today: context.today,
				schedule: { id: schedule.id, title: schedule.title },
				servers: servers.map(({ name, tools }) => ({
					name,
					tools: [...tools],
				})),
			};
			const output = await driver.exec(
				{
					name: `roundtable-precheck-${schedule.id}-${randomUUID().slice(0, 8)}`,
					image: options.image,
					runDir,
					workspaceDir,
					uid: options.uid,
					gid: options.gid,
					memoryMb: options.limits?.memoryMb ?? 256,
					cpus: options.limits?.cpus ?? 1,
					pids: options.limits?.pids ?? 32,
					entrypoint: options.entrypoint ?? PRECHECK_ENTRYPOINT,
					workspaceReadOnly: true,
				},
				JSON.stringify(input),
				signal,
				{ stdoutBytes: 64 * 1024 },
			);
			const answer: unknown = JSON.parse(output);
			if (!isRecord(answer) || typeof answer.ok !== "boolean")
				throw new Error("the precheck worker answered nothing it could read");
			if (!answer.ok)
				throw new Error(
					typeof answer.error === "string"
						? answer.error.slice(0, 1000)
						: "the script failed",
				);
			// The core checks the result's shape; a wrong one wakes the turn with what it was.
			return answer.result as PrecheckResult;
		} finally {
			await listener?.stop(true);
			// A cleanup failure is logged by nobody but must not replace the script's answer.
			for (const dir of dirs)
				try {
					rmSync(dir, { recursive: true, force: true });
				} catch {
					// Left for the operator; runRoot is dedicated to these runs.
				}
		}
	}
}
