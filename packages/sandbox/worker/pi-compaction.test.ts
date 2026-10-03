import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { HARD_COMPACT_TOKENS, SOFT_COMPACT_TOKENS } from "pi-roundtable/kit";
import { recordingLogger } from "pi-roundtable/testing";
import { type PiCompactor, PiSandboxBroker } from "../src/pi-broker.ts";
import type { PiCompactRequest, PiWorkerConfig } from "../src/pi-protocol.ts";
import { WorkerCompaction } from "./pi-compaction.ts";

const ENGINE = "host-compactor";
const WINDOW = 1_000_000;
const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const stop of stops.splice(0)) await stop();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A faux model with a 1M window whose every answer, a summary included, is "PI SUMMARY". */
const fauxModel: ExtensionFactory = (pi) => {
	const core = createFauxCore({
		provider: "faux",
		models: [{ id: "worker", contextWindow: WINDOW }],
	});
	core.setResponses(
		Array.from({ length: 20 }, () => fauxAssistantMessage("PI SUMMARY")),
	);
	pi.registerProvider("faux", {
		api: core.api,
		apiKey: "offline",
		baseUrl: "http://faux.invalid",
		streamSimple: core.streamSimple,
		models: core.models,
	});
};

/** A host broker with an admitted turn, so the worker's compaction routes answer. */
async function host(compactor?: PiCompactor) {
	const dir = mkdtempSync(join(tmpdir(), "sbx-compact-"));
	dirs.push(dir);
	const recorder = recordingLogger();
	const broker = new PiSandboxBroker({
		model: "host-model",
		oauthToken: () => "host-secret",
		...(compactor ? { compaction: compactor } : {}),
		logger: recorder.logger,
	});
	const socket = join(dir, "broker.sock");
	const listener = await broker.listen(socket);
	const turn = new AbortController();
	const release = broker.bind({
		channel: "discord:party",
		profile: "profile",
		speaker: { id: "guest", name: "Guest" },
		thinking: "low",
		signal: turn.signal,
	});
	stops.push(async () => {
		release();
		turn.abort();
		await listener.stop(true);
	});
	const config = (await (
		await fetch("http://broker/worker/config", { unix: socket })
	).json()) as PiWorkerConfig;
	return { dir, socket, config, lines: recorder.lines };
}

/** A worker session over the faux model, its history long enough that a compaction has work. */
async function worker(
	socket: string,
	config: PiWorkerConfig,
	dir: string,
	sessionDir?: string,
) {
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const history = sessionDir
		? SessionManager.create(dir, sessionDir)
		: SessionManager.inMemory(dir);
	for (let index = 0; index < 4; index++) {
		history.appendMessage({
			role: "user",
			content: `question ${index} ${"x".repeat(120_000)}`,
			timestamp: Date.now(),
		});
		history.appendMessage(fauxAssistantMessage(`answer ${index}`));
	}
	const logs: { msg: string; fields: Record<string, unknown> }[] = [];
	const compaction = new WorkerCompaction({
		history,
		contextWindow: (provider, id) =>
			modelRuntime.getModel(provider, id)?.contextWindow,
		config,
		socket,
		log: (msg, fields = {}) => logs.push({ msg, fields }),
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			{ name: "faux", factory: fauxModel },
			...compaction.extensions(),
		],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir,
		modelRuntime,
		resourceLoader,
		sessionManager: history,
		settingsManager: compaction.settings(),
		noTools: "builtin",
	});
	const model = modelRuntime.getModel("faux", "worker");
	if (!model) throw new Error("faux model missing");
	await session.setModel(model);
	const reports: Promise<void>[] = [];
	session.subscribe((event) => {
		if (event.type === "compaction_end")
			reports.push(compaction.ended(event, session));
	});
	stops.push(async () => session.dispose());
	return { session, history, compaction, logs, reports };
}

function latestCompaction(history: SessionManager) {
	const entry = history.getBranch().findLast((e) => e.type === "compaction");
	if (entry?.type !== "compaction") throw new Error("no compaction");
	return entry;
}

async function compactOnce(session: AgentSession, reports: Promise<void>[]) {
	await session.compact();
	await Promise.all(reports);
}

test("a 1M model compacts at 300k in the worker, as the host's sessions do", async () => {
	const { socket, config, dir } = await host({
		engine: ENGINE,
		compact: async () => undefined,
	});
	const { session } = await worker(socket, config, dir);
	const model = session.model;
	if (!model) throw new Error("no model");
	const settings = session.settingsManager.getCompactionSettings(model);
	expect(WINDOW - settings.reserveTokens).toBe(SOFT_COMPACT_TOKENS);
});

test("a compact request round-trips through the broker and becomes the session's compaction", async () => {
	const seen: PiCompactRequest[] = [];
	const { socket, config, dir, lines } = await host({
		engine: ENGINE,
		compact: async (request, { channel }) => {
			seen.push(request);
			expect(channel).toBe("discord:party");
			return {
				summary: "HOST SUMMARY",
				firstKeptEntryId: request.firstKeptEntryId,
				tokensBefore: request.tokensBefore,
				estimatedTokensAfter: 1234,
				details: { decisions: 3 },
			};
		},
	});
	expect(config).toEqual({ compaction: { engine: ENGINE } });
	const { session, history, reports } = await worker(socket, config, dir);
	await compactOnce(session, reports);
	const entry = latestCompaction(history);
	expect(entry.summary).toBe("HOST SUMMARY");
	expect(entry.details).toEqual({ decisions: 3, engine: ENGINE });
	const [request] = seen;
	expect(request?.reason).toBe("manual");
	expect(request?.messagesToSummarize.length).toBeGreaterThan(0);
	expect(request?.keptMessages.length).toBeGreaterThan(0);
	expect(request?.firstKeptEntryId).toBe(entry.firstKeptEntryId);
	const compacted = lines.find((l) => l.message === "conversation compacted");
	expect(compacted?.fields).toMatchObject({
		channel: "discord:party",
		trigger: "self",
		engine: "extension",
		tokensAfter: expect.any(Number),
		nextCompactionAt: SOFT_COMPACT_TOKENS,
	});
});

for (const [name, compactor, reason] of [
	[
		"the compactor declines",
		{ engine: ENGINE, compact: async () => undefined },
		"the compactor declined",
	],
	[
		"the compactor times out",
		{
			engine: ENGINE,
			timeoutMs: 1000,
			compact: () => new Promise<undefined>(() => {}),
		},
		"the compactor took over 1000 ms",
	],
	[
		"the request is oversized",
		{ engine: ENGINE, maxRequestBytes: 1024, compact: async () => undefined },
		"the request is over 1024 bytes",
	],
	[
		"the compactor throws",
		{
			engine: ENGINE,
			compact: async () => {
				throw new Error("service unreachable");
			},
		},
		"the compactor failed: Error: service unreachable",
	],
	[
		"the compactor changes the kept entry",
		{
			engine: ENGINE,
			compact: async (request: PiCompactRequest) => ({
				summary: "x",
				firstKeptEntryId: "elsewhere",
				tokensBefore: request.tokensBefore,
			}),
		},
		"the compactor's result is invalid",
	],
] as const) {
	test(`Pi's summary runs when ${name}`, async () => {
		const { socket, config, dir, lines } = await host(compactor as PiCompactor);
		const { session, history, reports } = await worker(socket, config, dir);
		await compactOnce(session, reports);
		expect(latestCompaction(history).summary).toContain("PI SUMMARY");
		expect(
			lines.find((l) => l.message === "compaction falls back to Pi's summary")
				?.fields,
		).toMatchObject({
			channel: "discord:party",
			engine: ENGINE,
			fallback: reason,
		});
		expect(
			lines.find((l) => l.message === "conversation compacted")?.fields,
		).toMatchObject({ engine: "pi", trigger: "self" });
	}, 15_000);
}

/** The worker's session_before_compact handler, loaded through the tiers' wrapper. */
function handlerOf(compaction: WorkerCompaction) {
	type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
	let handler: Handler | undefined;
	for (const { factory } of compaction.extensions())
		factory({
			on: (event: string, registered: Handler) => {
				if (event === "session_before_compact") handler = registered;
			},
		} as unknown as ExtensionAPI);
	return (tokensBefore: number, signal = new AbortController().signal) =>
		handler?.(
			{
				type: "session_before_compact",
				reason: "threshold",
				willRetry: false,
				signal,
				branchEntries: [],
				preparation: {
					firstKeptEntryId: "kept",
					messagesToSummarize: [],
					turnPrefixMessages: [],
					isSplitTurn: false,
					tokensBefore,
					fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				},
			},
			{},
		);
}

test("a compaction is written to the workspace session file and read back after a restart", async () => {
	const { socket, config, dir } = await host({
		engine: ENGINE,
		compact: async (request) => ({
			summary: "HOST SUMMARY",
			firstKeptEntryId: request.firstKeptEntryId,
			tokensBefore: request.tokensBefore,
		}),
	});
	const sessions = join(dir, "sessions");
	const { session, reports } = await worker(socket, config, dir, sessions);
	await compactOnce(session, reports);
	const reopened = SessionManager.continueRecent(dir, sessions);
	const entry = latestCompaction(reopened);
	expect(entry.summary).toBe("HOST SUMMARY");
	expect(entry.details).toEqual({ engine: ENGINE });
});

test("a turn gets a few host compactions; later ones fall back to Pi's summary", async () => {
	let calls = 0;
	const { socket, config, lines } = await host({
		engine: ENGINE,
		compact: async () => {
			calls++;
			return undefined;
		},
	});
	const compaction = new WorkerCompaction({
		history: SessionManager.inMemory("/tmp"),
		contextWindow: () => WINDOW,
		config,
		socket,
		log: () => {},
	});
	const compact = handlerOf(compaction);
	for (let index = 0; index < 5; index++)
		expect(await compact(SOFT_COMPACT_TOKENS + 1)).toBeUndefined();
	expect(calls).toBe(3);
	expect(
		lines.filter((l) => String(l.fields.fallback).includes("already asked"))
			.length,
	).toBe(2);
});

test("past 500k the host compactor is skipped for Pi's summary, and the host logs why", async () => {
	let calls = 0;
	const { socket, config, lines } = await host({
		engine: ENGINE,
		compact: async () => {
			calls++;
			return undefined;
		},
	});
	const compaction = new WorkerCompaction({
		history: SessionManager.inMemory("/tmp"),
		contextWindow: () => WINDOW,
		config,
		socket,
		log: () => {},
	});
	expect(await handlerOf(compaction)(HARD_COMPACT_TOKENS + 1)).toBeUndefined();
	await Bun.sleep(100);
	expect(calls).toBe(0);
	expect(
		lines.find(
			(l) => l.message === "compaction skips the extension for Pi's summary",
		)?.fields,
	).toMatchObject({
		channel: "discord:party",
		reason: "above the hard ceiling",
		tokensBefore: HARD_COMPACT_TOKENS + 1,
	});
});

test("a host compaction that left the context near 300k moves the next one to 500k, not straight back", () => {
	const history = SessionManager.inMemory("/tmp");
	const kept = history.appendMessage({
		role: "user",
		content: "x".repeat(4_000),
		timestamp: Date.now(),
	});
	history.appendCompaction("x".repeat(280_000 * 4), kept, 400_000, {
		engine: ENGINE,
	});
	const compaction = new WorkerCompaction({
		history,
		contextWindow: () => WINDOW,
		config: { compaction: { engine: ENGINE } },
		socket: "/nonexistent",
		log: () => {},
	});
	const settings = compaction
		.settings()
		.getCompactionSettings({ provider: "faux", id: "worker" } as never);
	expect(WINDOW - settings.reserveTokens).toBe(HARD_COMPACT_TOKENS);
});

test("an aborted compaction cancels the host compactor and falls back", async () => {
	let hostSignal: AbortSignal | undefined;
	const started = Promise.withResolvers<void>();
	const { socket, config } = await host({
		engine: ENGINE,
		compact: (_request, { signal }) => {
			hostSignal = signal;
			started.resolve();
			return new Promise(() => {});
		},
	});
	const compaction = new WorkerCompaction({
		history: SessionManager.inMemory("/tmp"),
		contextWindow: () => WINDOW,
		config,
		socket,
		log: () => {},
	});
	const abort = new AbortController();
	const answer = handlerOf(compaction)(SOFT_COMPACT_TOKENS + 1, abort.signal);
	await started.promise;
	abort.abort();
	expect(await answer).toBeUndefined();
	for (let i = 0; i < 50 && !hostSignal?.aborted; i++) await Bun.sleep(20);
	expect(hostSignal?.aborted).toBe(true);
});

test("without a host compactor the worker registers no compaction handler", async () => {
	const { config } = await host();
	expect(config).toEqual({});
	const compaction = new WorkerCompaction({
		history: SessionManager.inMemory("/tmp"),
		contextWindow: () => WINDOW,
		config,
		socket: "/nonexistent",
		log: () => {},
	});
	expect(compaction.extensions()).toEqual([]);
	// The tiers still apply, so Pi's summary compacts a 1M window at 300k.
	const settings = compaction
		.settings()
		.getCompactionSettings({ provider: "faux", id: "worker" } as never);
	expect(WINDOW - settings.reserveTokens).toBe(SOFT_COMPACT_TOKENS);
});
