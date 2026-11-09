import type { ChannelKey, Logger } from "pi-roundtable";
import type { SandboxCredentialScope } from "./broker.ts";
import type {
	PiCompaction,
	PiCompactRequest,
	PiThinkingLevel,
	PiToolResponse,
} from "./pi-protocol.ts";

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
	/** Actual configured image, named in capability failures so the operator can rebuild it. */
	workerImage?: string;
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

/** Refuses broker options that name an untrusted endpoint, a bad name, or a budget out of range. */
export function validateBrokerOptions(options: PiBrokerOptions): void {
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
}
