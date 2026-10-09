import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PiSandboxBroker } from "../src/pi-broker.ts";
import type { PiCompactRequest, PiTurnContext } from "../src/pi-protocol.ts";
import { WorkerCompaction } from "./pi-compaction.ts";
import {
	recordSandboxMemoryTurn,
	sandboxBridgeRefusal,
	speakerMemoryExtension,
} from "./pi-memory.ts";
import { brokerToolsExtension } from "./pi-tools.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const stop of cleanup.splice(0)) await stop();
});

async function worker(
	failure = false,
	summarized?: (request: PiCompactRequest) => void,
	options: {
		provider?: string;
		sharedPrompt?: boolean;
		noTools?: boolean;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "sbx-private-"));
	let session: AgentSession | undefined;
	const broker = new PiSandboxBroker({
		model: "test",
		oauthToken: () => "offline",
		tools: {
			names: ["recall_person"],
			call: async () => ({
				ok: !failure,
				text: "RESULT_SECRET",
				error: "RESULT_SECRET",
				privateTo: "ann",
			}),
		},
		...(summarized
			? {
					compaction: {
						engine: "recording",
						compact: async (request: PiCompactRequest) => {
							summarized(request);
							return {
								summary: "SAFE SUMMARY",
								firstKeptEntryId: request.firstKeptEntryId,
								tokensBefore: request.tokensBefore,
							};
						},
					},
				}
			: {}),
	});
	const socket = join(dir, "broker.sock");
	const listener = await broker.listen(socket);
	await broker.handle(
		new Request("http://broker/worker/ready", {
			method: "POST",
			body: JSON.stringify({
				capabilities: { privateTo: true, readerRecords: true },
			}),
		}),
	);
	const controller = new AbortController();
	const release = broker.bind({
		channel: "fake:party",
		profile: "test",
		speaker: { id: "ann-actor", name: "Ann", principalId: "ann" },
		thinking: "low",
		signal: controller.signal,
	});
	cleanup.push(async () => {
		session?.dispose();
		release();
		controller.abort();
		await listener.stop(true);
		rmSync(dir, { recursive: true, force: true });
	});
	const turn: PiTurnContext = {
		authorId: "ann-actor",
		authorPrincipalId: "ann",
		authorName: "Ann",
		memory: options.sharedPrompt ? "PARTY_WIDE_FACTS" : "PROMPT_SECRET",
		memoryVisibility: options.sharedPrompt ? "shared" : "private",
		outbox: dir,
	};
	const provider = options.provider ?? "faux";
	const core = createFauxCore({
		provider,
		models: [{ id: "worker", contextWindow: 1_000_000 }],
	});
	const seen: TranscriptContext[] = [];
	core.setResponses([
		...(options.noTools
			? []
			: [
					fauxAssistantMessage(
						fauxToolCall("recall_person", { query: "ARG_SECRET" }),
						{ stopReason: "toolUse" },
					),
				]),
		...Array.from({ length: 8 }, () => (context: TranscriptContext) => {
			seen.push(context);
			return fauxAssistantMessage("OK");
		}),
	]);
	const agentDir = join(dir, "agent");
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const history = SessionManager.inMemory(dir);
	const compaction = new WorkerCompaction({
		history,
		contextWindow: () => 1_000_000,
		config: summarized ? { compaction: { engine: "recording" } } : {},
		socket,
		log: () => {},
	});
	const loader = new DefaultResourceLoader({
		cwd: dir,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			{
				name: "faux",
				factory: (pi) =>
					pi.registerProvider(provider, {
						api: core.api,
						apiKey: "offline",
						baseUrl: "http://faux.invalid",
						streamSimple: core.streamSimple,
						models: core.models,
					}),
			},
			{
				name: "broker",
				factory: brokerToolsExtension(socket, dir, () => turn, [
					{
						name: "recall_person",
						label: "recall",
						description: "Recall private facts",
						parameters: Type.Object({ query: Type.String() }),
					},
				]),
			},
			{ name: "speaker-memory", factory: speakerMemoryExtension(() => turn) },
			...compaction.extensions(),
		],
	});
	await loader.reload();
	const created = await createAgentSession({
		cwd: dir,
		agentDir,
		modelRuntime,
		resourceLoader: loader,
		sessionManager: history,
		settingsManager: compaction.settings(),
		noTools: "builtin",
	});
	session = created.session;
	const model = modelRuntime.getModel(provider, "worker");
	if (!model) throw new Error("missing faux model");
	await session.setModel(model);
	session.setThinkingLevel("off");
	return { session, turn, seen };
}

test("sandbox real Pi prompt-only bridge turns refuse private cross-reader replay but allow shared party A to B to A", async () => {
	for (const sharedPrompt of [false, true]) {
		const { session, turn, seen } = await worker(false, undefined, {
			provider: "claude-bridge",
			sharedPrompt,
			noTools: true,
		});
		for (const reader of ["ann", "bo", "ann"]) {
			turn.authorId = `${reader}-actor`;
			turn.authorPrincipalId = reader;
			const refused = sandboxBridgeRefusal(session, turn);
			if (!sharedPrompt && reader === "bo") {
				expect(refused).toBeDefined();
				expect(seen.length).toBe(1);
				continue;
			}
			expect(refused).toBeUndefined();
			recordSandboxMemoryTurn(session.sessionManager, turn);
			await session.prompt(`Hello from ${reader}`);
		}
		expect(seen.length).toBe(sharedPrompt ? 3 : 2);
	}
});

for (const failure of [false, true])
	test(`sandbox broker ownership persists and hides custom arguments/results for other readers (${failure ? "error" : "success"})`, async () => {
		const { session, turn, seen } = await worker(failure);
		await session.prompt("Look up my fact");
		const result = session.messages.find(
			(message) => message.role === "toolResult",
		);
		expect(result?.role === "toolResult" && result.details).toMatchObject({
			privateTo: "ann",
		});
		expect(result?.role === "toolResult" && result.isError).toBe(failure);
		seen.splice(0);
		turn.authorId = "bo-actor";
		turn.authorPrincipalId = "bo";
		turn.memory = "Bo's memory";
		await session.prompt("Hello from Bo");
		const other = JSON.stringify(seen.pop());
		for (const secret of ["ARG_SECRET", "RESULT_SECRET", "PROMPT_SECRET"])
			expect(other).not.toContain(secret);
		expect(other).toContain("private memory, hidden");
		turn.authorId = "ann-actor";
		turn.authorPrincipalId = "ann";
		turn.memory = "PROMPT_SECRET";
		await session.prompt("Hello again");
		expect(JSON.stringify(seen.pop())).toContain("ARG_SECRET");
	});

test("sandbox host compactor receives no custom private exchange, including its kept tail", async () => {
	const requests: PiCompactRequest[] = [];
	const { session } = await worker(false, (request) => requests.push(request));
	await session.prompt("Look up my fact");
	for (let i = 0; i < 3; i++)
		await session.prompt(`public question ${i} ${"x".repeat(120_000)}`);
	const tailCall = fauxAssistantMessage(
		fauxToolCall("recall_person", { query: "ARG_SECRET" }),
		{ stopReason: "toolUse" },
	);
	const part = tailCall.content[0];
	if (part?.type !== "toolCall") throw new Error("missing tail call");
	session.sessionManager.appendMessage(tailCall);
	session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: part.id,
		toolName: "recall_person",
		content: [{ type: "text", text: "RESULT_SECRET" }],
		details: { privateTo: "ann" },
		isError: false,
		timestamp: Date.now(),
	});
	await session.compact();
	expect(requests.length).toBe(1);
	expect(JSON.stringify(requests[0]?.keptMessages)).toContain(
		"private memory, hidden",
	);
	for (const secret of ["ARG_SECRET", "RESULT_SECRET", "PROMPT_SECRET"])
		expect(JSON.stringify(requests)).not.toContain(secret);
});

test("sandbox bridge reader records refuse prompt-only private memory but allow public party turns", () => {
	for (const privateMemory of [false, true]) {
		const history = SessionManager.inMemory("/tmp");
		history.appendCustomEntry("roundtable-memory-turn", {
			reader: "ann",
			privateMemory,
		});
		const kept = history.appendMessage({
			role: "user",
			content: "public",
			timestamp: 1,
		});
		history.appendCompaction("safe summary", kept, 10);
		const turn: PiTurnContext = {
			authorId: "bo-actor",
			authorPrincipalId: "bo",
			authorName: "Bo",
			memory: "",
			outbox: "/tmp",
		};
		const refused = sandboxBridgeRefusal(
			{ model: { provider: "claude-bridge" }, sessionManager: history },
			turn,
		);
		if (privateMemory) expect(refused).toBeDefined();
		else expect(refused).toBeUndefined();
	}
});

test("sandbox shared prompt blocks keep A to B to A bridge turns public; default private blocks refuse B", () => {
	for (const memoryVisibility of [undefined, "shared"] as const) {
		const history = SessionManager.inMemory("/tmp");
		const session = {
			model: { provider: "claude-bridge" },
			sessionManager: history,
		};
		for (const reader of ["ann", "bo", "ann"]) {
			const turn: PiTurnContext = {
				authorId: reader,
				authorPrincipalId: reader,
				authorName: reader,
				memory: "party-wide facts",
				memoryVisibility,
				outbox: "/tmp",
			};
			const refused = sandboxBridgeRefusal(session, turn);
			if (reader === "bo" && memoryVisibility !== "shared")
				expect(refused).toBeDefined();
			else {
				expect(refused).toBeUndefined();
				recordSandboxMemoryTurn(history, turn);
			}
		}
	}
});

test("sandbox built-in Pi summary contains no custom private exchange or prompt memory", async () => {
	const { session, seen, turn } = await worker();
	await session.prompt("Look up my fact");
	for (let i = 0; i < 3; i++)
		await session.prompt(`public question ${i} ${"x".repeat(120_000)}`);
	seen.splice(0);
	await session.compact();
	const summary = JSON.stringify(seen);
	expect(seen.length).toBeGreaterThan(0);
	for (const secret of ["ARG_SECRET", "RESULT_SECRET", "PROMPT_SECRET"])
		expect(summary).not.toContain(secret);
	const bridge = {
		model: { provider: "claude-bridge" },
		sessionManager: session.sessionManager,
	};
	expect(sandboxBridgeRefusal(bridge, turn)).toBeUndefined();
	turn.authorPrincipalId = "bo";
	expect(sandboxBridgeRefusal(bridge, turn)).toMatch(/private exchanges/);
	expect(sandboxBridgeRefusal(session, turn)).toBeUndefined();
});
