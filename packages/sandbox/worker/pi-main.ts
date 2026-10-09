/**
 * Opt-in Pi worker: one session per isolated channel, no network or host credentials.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	activeToolsExtension,
	bridgeHistoryHidesMemory,
	carriesMemory,
	lastAssistant,
	mcpAdapterExtension,
	packageDir,
	readAttachmentExtension,
	textOf,
} from "pi-roundtable/kit";
import {
	PI_BROKER_SOCKET as BROKER_SOCKET,
	PI_RUN_DIR as CONTAINER_RUN_DIR,
	PI_WORKSPACE as CONTAINER_WORKSPACE,
	PI_FORWARDER_PORT as FORWARDER_PORT,
	isPiThinkingLevel as isPartyThinkingLevel,
	type PiMcpDiscovery as McpToolsResponse,
	type PiTurnRequest as PartyTurnRequest,
	type PiTurnResponse as PartyTurnResponse,
	PI_MEDIA_LIMITS,
	type PiWorkerConfig,
	safeFileName,
	type PiTurnContext as TurnContext,
	validatePiTurn,
	PI_ATTACHMENTS as WORKSPACE_ATTACHMENTS,
	PI_OUTBOX as WORKSPACE_OUTBOX,
} from "../src/pi-protocol.ts";
import { boundedText } from "../src/protocol.ts";
import { WorkerCompaction } from "./pi-compaction.ts";
import type { PiWorkerContent } from "./pi-content.ts";
import {
	recordSandboxMemoryTurn,
	sandboxBridgeRefusal,
	speakerMemoryExtension,
} from "./pi-memory.ts";
import {
	loadSkillIndex,
	skillsExtension,
	skillsPromptBlock,
} from "./pi-skills.ts";
import { boundedFile, brokerToolsExtension } from "./pi-tools.ts";

let content: PiWorkerContent;
/** The session's compaction, whose reports must reach the host before the turn's result. */
let workerCompaction: WorkerCompaction | undefined;
let baseTools: string[] = [];
const THINKING = "low";
const MCP_CONNECT_TIMEOUT_MS = 45_000;
/** The tools every run may use: the base set plus the profile's MCP tools, fixed at startup. */
let activeTools: readonly string[] = baseTools;
/** The running turn, read by broker-backed tools; turns never overlap, the host queues them. */
const turnContext: TurnContext = {
	authorId: "",
	authorName: "",
	outbox: "",
	memory: "",
};
const TURN_TIMEOUT_MS = 10 * 60_000;
const DROPPED_HEADERS = [
	"host",
	"connection",
	"content-length",
	"accept-encoding",
];
const DROPPED_RESPONSE_HEADERS = [
	"content-encoding",
	"content-length",
	"transfer-encoding",
];

function log(msg: string, fields: Record<string, unknown> = {}): void {
	console.log(
		JSON.stringify({ time: Date.now(), app: "sandbox-worker", msg, ...fields }),
	);
}

function without(headers: Headers, names: readonly string[]): Headers {
	const copy = new Headers(headers);
	for (const name of names) copy.delete(name);
	return copy;
}

/** Claude Code speaks only TCP, so loopback requests are forwarded to the host broker's socket. */
function startForwarder(): void {
	const broker = join(CONTAINER_RUN_DIR, BROKER_SOCKET);
	Bun.serve({
		hostname: "127.0.0.1",
		port: FORWARDER_PORT,
		idleTimeout: 0,
		async fetch(request) {
			// pi-lens-ignore: unchecked-throwing-call -- the server builds request.url, always an absolute URL
			const url = new URL(request.url);
			const hasBody = request.method !== "GET" && request.method !== "HEAD";
			const started = Date.now();
			const response = await fetch(
				`http://broker${url.pathname}${url.search}`,
				{
					unix: broker,
					method: request.method,
					headers: without(request.headers, DROPPED_HEADERS),
					body: hasBody
						? await boundedText(request.body, 96 * 1024 * 1024)
						: undefined,
					signal: request.signal,
				},
			).catch((error: unknown) => {
				log("broker call failed", {
					path: url.pathname,
					latencyMs: Date.now() - started,
					error: String(error),
				});
				throw error;
			});
			if (response.status >= 400)
				log("broker call failed", {
					path: url.pathname,
					status: response.status,
					latencyMs: Date.now() - started,
				});
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: without(response.headers, DROPPED_RESPONSE_HEADERS),
			});
		},
	});
}

/** The profile's MCP servers and their tools, as the host broker resolved them. */
async function mcpServers(): Promise<McpToolsResponse["servers"]> {
	// pi-lens-ignore: react-insecure-request -- it goes over the broker's Unix socket; "broker" names no host
	// nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
	const response = await fetch("http://broker/mcp-tools", {
		unix: join(CONTAINER_RUN_DIR, BROKER_SOCKET),
	});
	if (!response.ok)
		throw new Error(`the broker answered ${response.status} for mcp-tools`);
	return ((await response.json()) as McpToolsResponse).servers;
}

/** Whether the host compacts for this worker; an older broker without the route has no compactor. */
async function workerConfig(): Promise<PiWorkerConfig> {
	// Local Unix-socket transport; no TCP connection or DNS lookup is made.
	// nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
	const response = await fetch("http://broker/worker/config", {
		unix: join(CONTAINER_RUN_DIR, BROKER_SOCKET),
	});
	if (response.status === 404) {
		await response.body?.cancel();
		return {};
	}
	if (!response.ok)
		throw new Error(`the broker answered ${response.status} for worker/config`);
	return (await response.json()) as PiWorkerConfig;
}

/** pi-mcp-adapter registers tools only after its eager connection completes. */
async function waitForTools(
	session: AgentSession,
	expected: readonly string[],
): Promise<void> {
	const deadline = Date.now() + MCP_CONNECT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const registered = new Set(session.getAllTools().map((tool) => tool.name));
		if (expected.every((name) => registered.has(name))) return;
		await Bun.sleep(250);
	}
}

async function createSession(
	servers: McpToolsResponse["servers"],
	config: PiWorkerConfig,
): Promise<AgentSession> {
	const SKILLS = content.skillsDir ? loadSkillIndex(content.skillsDir) : [];
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? "/tmp/pi-agent";
	mkdirSync(agentDir, { recursive: true });
	const sessionDir = join(CONTAINER_WORKSPACE, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
	});
	const sessionManager = SessionManager.continueRecent(
		CONTAINER_WORKSPACE,
		sessionDir,
	);
	const compaction = new WorkerCompaction({
		history: sessionManager,
		contextWindow: (provider, id) =>
			modelRuntime.getModel(provider, id)?.contextWindow,
		config,
		socket: join(CONTAINER_RUN_DIR, BROKER_SOCKET),
		log,
	});
	workerCompaction = compaction;
	const resourceLoader = new DefaultResourceLoader({
		cwd: CONTAINER_WORKSPACE,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalExtensionPaths: [packageDir("pi-claude-bridge", import.meta.url)],
		extensionFactories: [
			{
				name: "read-attachment",
				factory: readAttachmentExtension(
					join(CONTAINER_WORKSPACE, WORKSPACE_ATTACHMENTS),
				),
			},
			{
				name: "broker-tools",
				factory: brokerToolsExtension(
					join(CONTAINER_RUN_DIR, BROKER_SOCKET),
					join(CONTAINER_WORKSPACE, WORKSPACE_ATTACHMENTS),
					() => turnContext,
					content.brokerTools ?? [],
				),
			},
			...(content.skillsDir
				? [
						{
							name: "skills",
							factory: skillsExtension(content.skillsDir, SKILLS),
						},
					]
				: []),
			{
				name: "speaker-memory",
				factory: speakerMemoryExtension(() => turnContext),
			},
			...(content.extensions?.(() => turnContext) ?? []),
			...compaction.extensions(),
			...(servers.length > 0
				? [
						{
							name: "mcp",
							// Through the loopback forwarder; the broker adds the credential.
							factory: mcpAdapterExtension(
								servers.map((server) => ({
									name: server.name,
									url: `http://127.0.0.1:${FORWARDER_PORT}/mcp/${server.name}`,
								})),
							),
						},
					]
				: []),
			// Last, so it pins the tools after every other extension's before_agent_start handler.
			{
				name: "active-tools",
				factory: activeToolsExtension(() => activeTools),
			},
		],
		appendSystemPrompt: [...(content.prompt ?? []), skillsPromptBlock(SKILLS)],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: CONTAINER_WORKSPACE,
		agentDir,
		thinkingLevel: THINKING,
		modelRuntime,
		resourceLoader,
		sessionManager,
		// Large windows compact at the soft threshold through the host's compactor, and through Pi's
		// summary past the hard ceiling, as the host's own sessions do.
		settingsManager: compaction.settings(),
		noTools: "builtin",
	});
	const model = modelRuntime.getModel(content.model.provider, content.model.id);
	if (!model)
		throw new Error(
			`model ${content.model.provider}/${content.model.id} is not available`,
		);
	await session.setModel(model);
	activeTools = [...baseTools, ...servers.flatMap((server) => server.tools)];
	await waitForTools(session, activeTools);
	const registered = new Set(session.getAllTools().map((tool) => tool.name));
	const claimed = SKILLS.flatMap((skill) => skill.tools);
	const missing = [...activeTools, ...claimed].filter(
		(name) => !registered.has(name),
	);
	if (missing.length > 0)
		throw new Error(`tools are not registered: ${missing.join(", ")}`);
	session.subscribe((event) => {
		if (event.type === "compaction_end") void compaction.ended(event, session);
		else if (event.type === "auto_retry_start")
			log("model call retried", {
				attempt: event.attempt,
				error: event.errorMessage,
			});
	});
	log("compaction ready", {
		hostCompactor: config.compaction?.engine ?? null,
	});
	return session;
}

async function runTurn(
	session: AgentSession,
	turn: PartyTurnRequest,
): Promise<PartyTurnResponse> {
	validatePiTurn(turn);
	if (!isPartyThinkingLevel(turn.thinking))
		return { ok: false, error: `unknown thinking level ${turn.thinking}` };
	const outbox = join(CONTAINER_WORKSPACE, WORKSPACE_OUTBOX, turn.turnId);
	mkdirSync(outbox, { recursive: true });
	turnContext.authorId = turn.author.id;
	turnContext.authorName = turn.author.name;
	turnContext.authorPrincipalId = turn.author.principalId;
	const refusal = sandboxBridgeRefusal(session, turnContext);
	if (refusal) return { ok: false, error: refusal };
	turnContext.outbox = outbox;
	turnContext.memory = turn.memory;
	turnContext.memoryVisibility = turn.memoryVisibility;
	const markPrivateMemory = recordSandboxMemoryTurn(
		session.sessionManager,
		turnContext,
	);
	session.setActiveToolsByName([...activeTools]);
	session.setThinkingLevel(turn.thinking);
	const timer = setTimeout(() => void session.abort(), TURN_TIMEOUT_MS);
	const toolCalls: string[] = [];
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_end" && carriesMemory(event.message))
			markPrivateMemory();
		if (event.type === "tool_execution_start") toolCalls.push(event.toolName);
		else if (event.type === "tool_execution_end" && event.isError)
			log("tool failed", {
				turnId: turn.turnId,
				tool: event.toolName,
				error: textOf(event.result?.content ?? []).slice(0, 2000),
			});
		else if (
			event.type === "message_end" &&
			event.message.role === "assistant" &&
			event.message.stopReason === "error"
		)
			log("model call failed", {
				turnId: turn.turnId,
				error: event.message.errorMessage,
			});
	});
	try {
		await session.prompt(
			`[${turn.author.name} (${turn.author.id})] ${turn.text}`,
			turn.images.length > 0
				? {
						images: turn.images.map((image) => ({
							type: "image" as const,
							...image,
						})),
					}
				: undefined,
		);
	} catch (error) {
		log("prompt failed", { turnId: turn.turnId, error: String(error) });
		return { ok: false, error: `prompt failed: ${String(error)}` };
	} finally {
		clearTimeout(timer);
		unsubscribe();
		log("turn finished", {
			turnId: turn.turnId,
			thinking: session.thinkingLevel,
			toolCalls,
		});
	}
	const last = lastAssistant(session.messages);
	if (!last.ok) return last;
	const text = textOf(last.message.content).trim();
	if (!text || text.length > 100_000)
		return { ok: false, error: "Final text bounds exceeded" };
	const files = existsSync(outbox) ? readdirSync(outbox) : [];
	if (
		files.length > PI_MEDIA_LIMITS.files ||
		files.some((name) => !safeFileName(name))
	)
		return { ok: false, error: "Output file bounds exceeded" };
	if (files.length === 0) rmSync(outbox, { recursive: true, force: true });
	let total = 0;
	const replies = files.map((name) => {
		const data = boundedFile(join(outbox, name), PI_MEDIA_LIMITS.fileBytes);
		total += data.byteLength;
		if (total > PI_MEDIA_LIMITS.totalFileBytes)
			throw new Error("Reply byte budget exceeded");
		return { name, data: Buffer.from(data).toString("base64") };
	});
	return { ok: true, text, files: replies };
}

async function main(): Promise<void> {
	const profile = process.env.SANDBOX_PROFILE ?? "";
	const contentModule = process.env.SANDBOX_CONTENT ?? "/app/worker/content.ts";
	const loaded = (await import(contentModule)) as {
		workerContent(profile: string): PiWorkerContent | Promise<PiWorkerContent>;
	};
	content = await loaded.workerContent(profile);
	baseTools = [
		"read_attachment",
		...(content.skillsDir ? ["read_skill"] : []),
		...(content.brokerTools ?? []).map((tool) => tool.name),
		...(content.toolNames ?? []),
	];
	activeTools = baseTools;
	mkdirSync(process.env.HOME ?? "/tmp/home", { recursive: true });

	startForwarder();
	const servers = await mcpServers();
	const session = await createSession(servers, await workerConfig());

	const brokerSocket = join(CONTAINER_RUN_DIR, BROKER_SOCKET);
	log("sandbox worker ready", { profile, tools: activeTools.length });
	// A broker that stays unreachable is logged once, not every quarter second.
	let pollFailing = false;
	for (;;) {
		try {
			// Local Unix-socket transport; no TCP connection or DNS lookup is made.
			// nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
			const ready = await fetch("http://broker/worker/ready", {
				unix: brokerSocket,
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					capabilities: { privateTo: true, readerRecords: true },
					privateHistory: bridgeHistoryHidesMemory(
						session.sessionManager.getBranch(),
						undefined,
					),
				}),
				signal: AbortSignal.timeout(5000),
			});
			await ready.body?.cancel();
			// Local Unix-socket transport; no TCP connection or DNS lookup is made.
			// nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
			const next = await fetch("http://broker/worker/next", {
				unix: brokerSocket,
				signal: AbortSignal.timeout(55_000),
			});
			if (!next.ok) {
				await next.body?.cancel();
				await Bun.sleep(250);
				continue;
			}
			const turn: unknown = JSON.parse(
				await boundedText(next.body, 96 * 1024 * 1024),
			);
			validatePiTurn(turn);
			pollFailing = false;
			const result = await runTurn(session, turn).catch((error: unknown) => {
				log("turn output failed", {
					turnId: turn.turnId,
					error: String(error),
				});
				return { ok: false as const, error: "Worker output failed" };
			});
			await workerCompaction?.settled();
			// Local Unix-socket transport; no TCP connection or DNS lookup is made.
			// nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
			const sent = await fetch("http://broker/worker/result", {
				unix: brokerSocket,
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ turnId: turn.turnId, result }),
				signal: AbortSignal.timeout(60_000),
			});
			await sent.body?.cancel();
		} catch (error) {
			if (!pollFailing) log("broker poll failed", { error: String(error) });
			pollFailing = true;
			await Bun.sleep(250);
		}
	}
}

main().catch((error: unknown) => {
	log("sandbox worker failed", { error: String(error) });
	process.exit(1);
});
