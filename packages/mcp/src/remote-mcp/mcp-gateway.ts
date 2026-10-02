import { timingSafeEqual } from "node:crypto";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { HttpRoute, Logger } from "pi-roundtable";
import {
	CHANNEL_TOOLS,
	type ChannelExecutor,
	ChannelToolError,
	parseChannelTool,
} from "pi-roundtable/discord";
import { type TSchema, Type } from "typebox";
import Value from "typebox/value";
import packageJson from "../../package.json" with { type: "json" };
import {
	CHANNEL_TOKEN_PATTERN,
	type ChannelBundle,
	type ChannelGrantStore,
	hashChannelToken,
} from "./channel-grants.ts";
import { runGrantedTool } from "./channel-tools.ts";
import {
	DEFAULT_TOOL_NAMES,
	REMOTE_MCP_MESSAGES,
	type RemoteMcpMessages,
	type RemoteToolNames,
} from "./messages.ts";
import { type RemoteAgent, RemoteAgentError } from "./remote-agent.ts";

/** Requests may carry uploads; anything larger is refused before it is parsed. */
const MAX_BODY_BYTES = 12 * 1024 * 1024;

const LIST_CHANNELS_TOOL = "discord_list_authorized_channels";

export interface McpGatewayOptions {
	/** Bearer token for /mcp/personal. */
	dispatchToken: string;
	agent: Pick<RemoteAgent, "dispatch" | "result">;
	grants: ChannelGrantStore;
	/** Undefined until the Discord connection is ready. */
	executor(): ChannelExecutor | undefined;
	logger: Logger;
	messages?: RemoteMcpMessages;
	/** The names of the dispatch and result tools; `agent_dispatch` and `agent_result` by default. */
	toolNames?: RemoteToolNames;
}

interface ToolSpec {
	tool: Tool;
	call(args: Record<string, unknown>): Promise<unknown>;
}

// The round trip drops TypeBox's symbol keys and leaves plain JSON Schema.
const jsonSchema = (schema: Readonly<TSchema>): Tool["inputSchema"] =>
	JSON.parse(JSON.stringify(schema));

const textResult = (value: unknown, isError = false) => ({
	content: [{ type: "text" as const, text: JSON.stringify(value ?? {}) }],
	...(isError ? { isError: true } : {}),
});

class BadRequest extends Error {}

const ResultInput = Type.Object(
	{ runId: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);

/**
 * The owner's MCP endpoints for outside agents, on a listener the public hostname reaches:
 * /mcp/personal relays turns to the owner's agent, /mcp/discord/<token> exposes one bundle's
 * granted channels. Each request gets a fresh stateless MCP server.
 */
export class McpGateway {
	readonly #options: McpGatewayOptions;
	readonly #text: RemoteMcpMessages;
	readonly #tools: RemoteToolNames;
	readonly #dispatchInput: TSchema;

	constructor(options: McpGatewayOptions) {
		this.#options = options;
		this.#text = options.messages ?? REMOTE_MCP_MESSAGES;
		this.#tools = options.toolNames ?? DEFAULT_TOOL_NAMES;
		this.#dispatchInput = Type.Object(
			{
				message: Type.String({ minLength: 1 }),
				sessionId: Type.Optional(
					Type.String({ description: this.#text.sessionIdDescription }),
				),
			},
			{ additionalProperties: false },
		);
	}

	/** Both endpoints take every method and answer the ones they refuse themselves. */
	routes(listener: string): HttpRoute[] {
		const handle = (request: Request) => this.handle(request);
		return [
			{
				name: "mcp-personal",
				listener,
				path: { exact: "/mcp/personal" },
				handle,
			},
			{
				name: "mcp-discord",
				listener,
				path: { prefix: "/mcp/discord/" },
				handle,
			},
		];
	}

	/** Never throws; error responses never repeat the URL, which may hold a token. */
	async handle(request: Request): Promise<Response> {
		const path = new URL(request.url).pathname;
		const discord = path.startsWith("/mcp/discord/");
		if (path !== "/mcp/personal" && !discord)
			return new Response("Not found", { status: 404 });
		if (request.headers.get("Origin"))
			return new Response("Forbidden origin", { status: 403 });
		if (request.method !== "POST")
			return new Response("Method not allowed", {
				status: 405,
				headers: { Allow: "POST" },
			});
		try {
			const tools = discord
				? await this.#toolsForToken(path.slice("/mcp/discord/".length))
				: this.#personalTools(request);
			if (!tools) return new Response("Unauthorized", { status: 401 });
			const response = await serveMcp(
				await boundedBody(request),
				discord ? "roundtable-discord-channel" : "roundtable-personal-agent",
				tools,
				this.#text,
			);
			response.headers.set("Cache-Control", "no-store");
			response.headers.set("Referrer-Policy", "no-referrer");
			return response;
		} catch (error) {
			if (error instanceof BadRequest)
				return new Response("Request too large", { status: 413 });
			this.#options.logger.error(
				{ endpoint: discord ? "discord" : "personal", err: error },
				"mcp request failed",
			);
			return new Response("Unavailable", { status: 503 });
		}
	}

	async #toolsForToken(token: string): Promise<ToolSpec[] | undefined> {
		if (!CHANNEL_TOKEN_PATTERN.test(token)) return undefined;
		const bundle = await this.#options.grants.bundleByTokenHash(
			hashChannelToken(token),
		);
		return bundle && this.#channelTools(bundle);
	}

	/** The relay tools for a request that carries the dispatch token; undefined otherwise. */
	#personalTools(request: Request): ToolSpec[] | undefined {
		return this.#bearerMatches(request) ? this.#dispatchTools() : undefined;
	}

	#bearerMatches(request: Request): boolean {
		const header = request.headers.get("Authorization") ?? "";
		if (!header.startsWith("Bearer ")) return false;
		const given = Buffer.from(header.slice("Bearer ".length));
		const expected = Buffer.from(this.#options.dispatchToken);
		return given.length === expected.length && timingSafeEqual(given, expected);
	}

	#dispatchTools(): ToolSpec[] {
		const { agent } = this.#options;
		return [
			{
				tool: {
					name: this.#tools.dispatch,
					description: this.#text.dispatchDescription(this.#tools),
					inputSchema: jsonSchema(this.#dispatchInput),
				},
				call: async (args) => {
					if (!Value.Check(this.#dispatchInput, args))
						return textResult({ error: "INVALID_ARGUMENTS" }, true);
					const input = args as { message: string; sessionId?: string };
					return textResult(
						await agent.dispatch(input.message, input.sessionId),
					);
				},
			},
			{
				tool: {
					name: this.#tools.result,
					description: this.#text.resultDescription(this.#tools),
					inputSchema: jsonSchema(ResultInput),
					annotations: { readOnlyHint: true, idempotentHint: true },
				},
				call: async (args) => {
					if (!Value.Check(ResultInput, args))
						return textResult({ error: "INVALID_ARGUMENTS" }, true);
					return textResult(agent.result(String(args.runId)));
				},
			},
		];
	}

	async #channelTools(bundle: ChannelBundle): Promise<ToolSpec[]> {
		const { grants } = this.#options;
		const executor = () => {
			const current = this.#options.executor();
			if (!current) throw new ChannelToolError("DISCORD_UNAVAILABLE");
			return current;
		};
		const granted = new Set(
			(await grants.grants(bundle.id)).flatMap((grant) => grant.operations),
		);
		const tools: ToolSpec[] = [this.#listChannelsTool(bundle, executor)];
		for (const [name, spec] of Object.entries(CHANNEL_TOOLS)) {
			if (!granted.has(spec.operation)) continue;
			const read = spec.operation === "read";
			tools.push({
				tool: {
					name,
					description: `${spec.description}${this.#text.channelToolNote(bundle.name)}`,
					inputSchema: jsonSchema(spec.schema),
					annotations: {
						readOnlyHint: read,
						destructiveHint: !["read", "pin"].includes(spec.operation),
						// Writes may upload files or notify people; only reads are safe to repeat.
						idempotentHint: read,
						openWorldHint: true,
					},
				},
				call: async (args) =>
					textResult(
						await runGrantedTool(
							bundle,
							name,
							parseChannelTool(name, args),
							grants,
							executor(),
							this.#text,
						),
					),
			});
		}
		return tools;
	}

	/** The bundle's channels with their names and operations; always offered. */
	#listChannelsTool(
		bundle: ChannelBundle,
		executor: () => ChannelExecutor,
	): ToolSpec {
		const { grants } = this.#options;
		return {
			tool: {
				name: LIST_CHANNELS_TOOL,
				description: this.#text.listChannelsDescription,
				inputSchema: { type: "object", properties: {} },
				annotations: { readOnlyHint: true, idempotentHint: true },
			},
			call: async () => {
				const current = await grants.bundleByTokenHash(bundle.tokenHash);
				if (current?.id !== bundle.id)
					return textResult({ error: "ENDPOINT_REVOKED" }, true);
				const run = executor();
				const channels = await Promise.all(
					(await grants.grants(bundle.id)).map(async (grant) => {
						const names = await run.names(grant.channelId);
						return {
							channelId: grant.channelId,
							guildId: grant.guildId,
							name: grant.displayName,
							description: grant.description,
							guildName: names?.guildName ?? grant.guildName,
							channelName: names?.channelName ?? grant.channelName,
							operations: grant.operations,
							accessible: names !== undefined,
						};
					}),
				);
				return textResult({ bundle: bundle.name, channels });
			},
		};
	}
}

async function serveMcp(
	request: Request,
	name: string,
	tools: ToolSpec[],
	text: RemoteMcpMessages,
): Promise<Response> {
	const server = new McpServer(
		{ name, version: packageJson.version },
		{ capabilities: { tools: {} } },
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map((spec) => spec.tool),
	}));
	server.setRequestHandler(CallToolRequestSchema, async (call) => {
		const spec = tools.find((t) => t.tool.name === call.params.name);
		if (!spec) return textResult({ error: "UNKNOWN_TOOL" }, true);
		try {
			return (await spec.call(call.params.arguments ?? {})) as ReturnType<
				typeof textResult
			>;
		} catch (error) {
			if (
				error instanceof ChannelToolError ||
				error instanceof RemoteAgentError
			)
				return textResult({ error: error.code }, true);
			return textResult({ error: text.operationUnfinished }, true);
		}
	});
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	await server.connect(transport);
	try {
		return await transport.handleRequest(request);
	} finally {
		await server.close();
	}
}

/** The request with its body read to memory, refusing more than MAX_BODY_BYTES. */
async function boundedBody(request: Request): Promise<Request> {
	if (Number(request.headers.get("Content-Length")) > MAX_BODY_BYTES)
		throw new BadRequest();
	const reader = request.body?.getReader();
	if (!reader) return request;
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_BODY_BYTES) {
			await reader.cancel();
			throw new BadRequest();
		}
		chunks.push(value);
	}
	return new Request(request, { body: Buffer.concat(chunks, size) });
}
