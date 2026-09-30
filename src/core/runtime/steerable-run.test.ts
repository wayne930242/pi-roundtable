import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	createFauxCore,
	type FauxResponseStep,
	fauxAssistantMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { SteerableRun, type SteeringSession } from "./steerable-run.ts";

/** A real Pi session on the faux provider, whose scripted answers may wait on the test. */
async function fauxSession(steps: FauxResponseStep[]) {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-steer-"));
	const core = createFauxCore({ provider: "faux", models: [{ id: "faux-1" }] });
	core.setResponses(steps);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerProvider("faux", {
		api: core.api,
		apiKey: "test",
		baseUrl: "http://faux.invalid",
		streamSimple: core.streamSimple,
		models: [
			{
				id: "faux-1",
				name: "Faux",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 1_000,
			},
		],
	});
	const model = modelRuntime.getModel("faux", "faux-1");
	if (!model) throw new Error("faux model not registered");
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		modelRuntime,
		model,
		resourceLoader,
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory({}),
		noTools: "all",
	});
	return { session, core };
}

/** A promise the test resolves by hand. */
function gate() {
	let open = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

const userTexts = (context: TranscriptContext) =>
	context.messages
		.filter((m) => m.role === "user")
		.map((m) =>
			typeof m.content === "string"
				? m.content
				: m.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
		);

const answers = (session: AgentSession) =>
	session.messages
		.filter((m): m is AssistantMessage => m.role === "assistant")
		.map((m) =>
			m.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
		);

describe("SteerableRun on a Pi session", () => {
	let seen: string[][];
	beforeEach(() => {
		seen = [];
	});

	test("a steer during the run is answered in the same turn", async () => {
		const thinking = gate();
		const started = gate();
		const { session } = await fauxSession([
			async (context) => {
				seen.push(userTexts(context));
				started.open();
				await thinking.opened;
				return fauxAssistantMessage("first answer");
			},
			(context) => {
				seen.push(userTexts(context));
				return fauxAssistantMessage("answer after the addition");
			},
		]);
		const run = new SteerableRun(session, () => true);
		const done = run.run(() => session.prompt("look this up for me"));
		await started.opened;
		expect(await run.steer("also check journald", [])).toBe(true);
		thinking.open();
		await done;
		expect(run.steered).toBe(true);
		expect(seen[1]).toEqual(["look this up for me", "also check journald"]);
		expect(answers(session)).toEqual([
			"first answer",
			"answer after the addition",
		]);
	});

	test("a steer at agent_end is answered in the same turn by Pi itself", async () => {
		const { session } = await fauxSession([
			fauxAssistantMessage("first answer"),
			(context) => {
				seen.push(userTexts(context));
				return fauxAssistantMessage("answer after the addition");
			},
		]);
		const run = new SteerableRun(session, () => true);
		let late: Promise<boolean> | undefined;
		// agent_end fires after Pi's last look at its steering queue.
		session.subscribe((event) => {
			if (event.type === "agent_end" && !late)
				late = run.steer("a late addition", []);
		});
		await run.run(() => session.prompt("look this up for me"));
		expect(await late).toBe(true);
		expect(seen.at(-1)).toContain("a late addition");
		expect(session.getSteeringMessages()).toEqual([]);
	});

	test("stop aborts the run and drops its steers", async () => {
		const started = gate();
		const { session, core } = await fauxSession([
			(_context, options) => {
				started.open();
				return new Promise<AssistantMessage>((resolve) =>
					options?.signal?.addEventListener("abort", () =>
						resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
					),
				);
			},
			fauxAssistantMessage("must not appear"),
		]);
		const run = new SteerableRun(session, () => true);
		const done = run.run(() => session.prompt("a long-running job"));
		await started.opened;
		expect(await run.steer("this line is dropped", [])).toBe(true);
		expect(run.stop()).toBe(true);
		await done;
		expect(run.stopped).toBe(true);
		expect(core.state.callCount).toBe(1);
		expect(session.getSteeringMessages()).toEqual([]);
		expect(run.stop()).toBe(false);
	});

	test("a turn that may not be steered, or has ended, takes nothing", async () => {
		const started = gate();
		const finish = gate();
		const { session } = await fauxSession([
			async () => {
				started.open();
				await finish.opened;
				return fauxAssistantMessage("done");
			},
		]);
		const run = new SteerableRun(session, () => false);
		const done = run.run(() => session.prompt("a scheduled job"));
		await started.opened;
		expect(await run.steer("cannot be inserted", [])).toBe(false);
		finish.open();
		await done;
		expect(await run.steer("too late", [])).toBe(false);
		expect(session.getSteeringMessages()).toEqual([]);
	});
});

/**
 * The window Pi leaves open: its input handling ends after the session settled, so the steer
 * sits in the queue with no run to take it.
 */
class SettledSession {
	isStreaming = true;
	queue: string[] = [];
	prompts: string[] = [];
	async steer(text: string) {
		this.queue.push(text);
	}
	getSteeringMessages() {
		return this.queue;
	}
	clearQueue() {
		const steering = this.queue;
		this.queue = [];
		return { steering, followUp: [] };
	}
	async abort() {}
	async waitForIdle() {}
	async prompt(text: string) {
		this.prompts.push(text);
	}
}

describe("SteerableRun leftovers", () => {
	test("a steer Pi left queued as the run ended is prompted in the same turn", async () => {
		const session = new SettledSession();
		const run = new SteerableRun(
			session as unknown as SteeringSession,
			() => true,
		);
		await run.run(async () => {
			expect(await run.steer("a late addition", [])).toBe(true);
			session.isStreaming = false;
		});
		expect(session.prompts).toEqual(["a late addition"]);
		expect(session.queue).toEqual([]);
	});

	test("a steer queued after the turn ended is taken back", async () => {
		const session = new SettledSession();
		const run = new SteerableRun(
			session as unknown as SteeringSession,
			() => true,
		);
		const settled = gate();
		let late: Promise<boolean> | undefined;
		session.steer = async (text: string) => {
			// Pi's input handling finishes only after the turn is over.
			await settled.opened;
			session.queue.push(text);
		};
		await run.run(async () => {
			late = run.steer("a late addition", []);
		});
		settled.open();
		expect(await late).toBe(false);
		expect(session.queue).toEqual([]);
		expect(session.prompts).toEqual([]);
	});
});
