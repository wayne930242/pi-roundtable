import { expect, test } from "bun:test";
import {
	PluginError,
	REPLY_FILE_LIMITS,
	type SessionContext,
	THE_SPEAKER,
	WORKER_SESSIONS,
} from "pi-roundtable";
import { servicePair, testPlugin } from "pi-roundtable/testing";
import { BrowserToolError } from "./driver.ts";
import { browserAgent } from "./plugin.ts";
import {
	type FakeDriver,
	FilesSurface,
	fakeDriver,
	LEAKED_SECRET,
	scriptedSessions,
} from "./testing/fakes.ts";

async function open(
	script: Parameters<typeof scriptedSessions>[0],
	options: Parameters<typeof browserAgent>[0] = {},
	driver: FakeDriver = fakeDriver(),
) {
	const sessions = scriptedSessions(script);
	const harness = await testPlugin(browserAgent({ driver, ...options }), {
		services: [servicePair(WORKER_SESSIONS, sessions)],
		surfaces: [new FilesSurface()],
	});
	return { harness, sessions, driver };
}

/** Calls the tool as a session does, with the turn's signal, which `runTool` does not give. */
async function runWithSignal(
	harness: Awaited<ReturnType<typeof testPlugin>>,
	args: Record<string, unknown>,
	signal: AbortSignal,
) {
	const factory = harness.contribution.tools
		?.find((tool) => tool.name === "browser_task")
		?.session.snapshot()
		.factory({
			kind: "agent",
			homeChannel: "test:1",
			turnChannel: "test:1",
			compaction: { wrap: (factory) => factory },
			conversation: { visibility: "shared" },
			addressee: THE_SPEAKER,
			memory: "speaker",
			speaker: () => undefined,
			runTask: async () => "",
		} satisfies SessionContext);
	let execute:
		| ((id: string, params: unknown, signal: AbortSignal) => Promise<unknown>)
		| undefined;
	// SAFETY: the extension only registers the tool.
	await factory?.({
		registerTool: (tool: { execute: typeof execute }) => {
			execute = tool.execute;
		},
	} as never);
	if (!execute) throw new Error("browser_task did not register");
	return execute("call", args, signal);
}

test("browser_task runs a worker with only the driver's tools, returns its report, and attaches the screenshots it kept", async () => {
	const { harness, sessions, driver } = await open(async (worker) => {
		expect(worker.registered).toEqual([
			"browser_look",
			"browser_boom",
			"browser_shot",
		]);
		expect((await worker.call("browser_look", { what: "news" })).text).toBe(
			"page says news",
		);
		expect((await worker.call("browser_shot")).images).toBe(1);
		await worker.call("browser_shot");
		return "Report: the page says news.";
	});
	const text = await harness.runTool("browser_task", {
		task: "Read the news page and report in English.",
		url: "https://example.com/news",
	});
	expect(text).toBe(
		"Report: the page says news.\n\n2 screenshots are attached to your reply.",
	);
	expect(harness.files.map(({ file }) => file.name)).toEqual([
		"browser-1.png",
		"browser-2.png",
	]);
	expect(harness.files[0]?.file.data.byteLength).toBe(64);
	expect(driver.started).toBe(1);
	expect(driver.disposed).toBe(1);
	const request = sessions.requests[0];
	expect(request?.task).toBe(
		"Read the news page and report in English.\n\nStart from this page: https://example.com/news",
	);
	expect(request?.toolNames).toEqual([
		"browser_look",
		"browser_boom",
		"browser_shot",
	]);
	// The worker reads the standing rules, the driver's instructions and its skill, and nothing else.
	expect(request?.prompt).toContain("You are a browser worker");
	expect(request?.prompt).toContain("language of the task");
	expect(request?.prompt).toContain("FAKE-DRIVER-PROMPT");
	expect(request?.prompt).toContain("FAKE-SKILL-BODY");
	expect(request?.model).toBeUndefined();
});

test("the model and thinking level come from the options, and default to the host's delegation settings", async () => {
	const given = await open(async () => "ok", {
		model: "anthropic/claude-sonnet-5-5",
		thinking: "high",
	});
	await given.harness.runTool("browser_task", { task: "t" });
	expect(given.sessions.requests[0]?.model).toBe("anthropic/claude-sonnet-5-5");
	expect(given.sessions.requests[0]?.thinking).toBe("high");
	const defaults = await open(async () => "ok");
	await defaults.harness.runTool("browser_task", { task: "t" });
	expect(defaults.sessions.requests[0]?.model).toBeUndefined();
	expect(defaults.sessions.requests[0]?.thinking).toBeUndefined();
});

test("the tool needs the owner tier and holds nothing", async () => {
	const { harness } = await open(async () => "ok");
	expect(harness.tools).toEqual(["browser_task"]);
	expect(harness.tiers.minTier("browser_task")).toBe("owner");
	expect(
		await harness.holds("browser_task", { task: "t" }, undefined as never),
	).toBeUndefined();
});

test("the step limit refuses the call after it and tells the worker to report", async () => {
	const { harness } = await open(
		async (worker) => {
			const results = [];
			for (let i = 0; i < 4; i++)
				results.push(await worker.call("browser_look"));
			expect(results.map((r) => r.isError)).toEqual([false, false, true, true]);
			expect(results[2]?.text).toContain("step limit of 2");
			return "partial report";
		},
		{ limits: { maxSteps: 2 } },
	);
	expect(await harness.runTool("browser_task", { task: "t" })).toBe(
		"partial report",
	);
});

test("the screenshot count and size limits refuse a keep with a message the worker reads", async () => {
	const count = await open(
		async (worker) => {
			const calls = [];
			for (let i = 0; i < 3; i++) calls.push(await worker.call("browser_shot"));
			expect(calls.map((c) => c.isError)).toEqual([false, false, true]);
			expect(calls[2]?.text).toContain("At most 2 screenshots");
			return "done";
		},
		{ limits: { maxScreenshots: 2 } },
	);
	await count.harness.runTool("browser_task", { task: "t" });
	expect(count.harness.files).toHaveLength(2);
	const size = await open(
		async (worker) => {
			const call = await worker.call("browser_shot");
			expect(call.isError).toBe(true);
			expect(call.text).toContain("the most that can be kept is 100");
			return "done";
		},
		{ limits: { maxScreenshotBytes: 100 } },
		fakeDriver({ screenshotBytes: 101 }),
	);
	await size.harness.runTool("browser_task", { task: "t" });
	expect(size.harness.files).toHaveLength(0);
});

test("a tool's output is cut at the output limit, and an unexpected error reaches the worker scrubbed", async () => {
	const driver = fakeDriver();
	const { harness } = await open(
		async (worker) => {
			const long = await worker.call("browser_look", { what: "x".repeat(500) });
			expect(long.text.length).toBeLessThan(200);
			expect(long.text).toContain("[output cut at 50 characters]");
			const failed = await worker.call("browser_boom");
			expect(failed.isError).toBe(true);
			expect(failed.text).toContain("upstream said no");
			expect(failed.text).not.toContain(LEAKED_SECRET);
			return "ok";
		},
		{ limits: { maxOutputChars: 50 } },
		driver,
	);
	await harness.runTool("browser_task", { task: "t" });
});

test("a time limit ends the task, keeps what was taken, cleans up, and says so", async () => {
	const { harness, driver } = await open(
		async (worker) => {
			await worker.call("browser_shot");
			await new Promise((_resolve, reject) =>
				worker.request.signal.addEventListener("abort", () =>
					reject(worker.request.signal.reason),
				),
			);
			return "never";
		},
		{ limits: { timeoutMs: 50 } },
	);
	const text = await harness.runTool("browser_task", { task: "t" });
	expect(text).toContain("The browser task ran out of time");
	expect(text).toContain("1 screenshot is attached to your reply.");
	expect(harness.files).toHaveLength(1);
	expect(driver.disposed).toBe(1);
});

test("cancelling the turn stops the worker, cleans up, and attaches nothing", async () => {
	const turn = new AbortController();
	let reached: () => void = () => undefined;
	const inside = new Promise<void>((resolve) => {
		reached = resolve;
	});
	const { harness, driver } = await open(async (worker) => {
		await worker.call("browser_look");
		reached();
		await new Promise((_resolve, reject) =>
			worker.request.signal.addEventListener("abort", () =>
				reject(worker.request.signal.reason),
			),
		);
		return "never";
	});
	const running = runWithSignal(harness, { task: "t" }, turn.signal);
	await inside;
	turn.abort(new Error("turn cancelled"));
	await expect(running).rejects.toThrow("turn cancelled");
	expect(driver.disposed).toBe(1);
});

test("stopping the host aborts running tasks and waits for their cleanup; busy lists them", async () => {
	let reached: () => void = () => undefined;
	const inside = new Promise<void>((resolve) => {
		reached = resolve;
	});
	const { harness, driver } = await open(async (worker) => {
		reached();
		await new Promise((_resolve, reject) =>
			worker.request.signal.addEventListener("abort", () =>
				reject(worker.request.signal.reason),
			),
		);
		return "never";
	});
	const service = harness.contribution.services?.find(
		(item) => item.name === "browser-tasks",
	);
	expect(service?.busy?.()).toEqual([]);
	const running = runWithSignal(
		harness,
		{ task: "t" },
		new AbortController().signal,
	);
	const settled = running.catch((error: unknown) => error);
	await inside;
	expect(service?.busy?.()).toEqual(["browser task"]);
	await service?.stop?.();
	expect(driver.disposed).toBe(1);
	expect(await settled).toBeInstanceOf(Error);
	expect(service?.busy?.()).toEqual([]);
});

test("tasks past the concurrency limit are refused until one ends", async () => {
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let reached: () => void = () => undefined;
	const inside = new Promise<void>((resolve) => {
		reached = resolve;
	});
	const { harness } = await open(
		async () => {
			reached();
			await gate;
			return "ok";
		},
		{ maxConcurrentTasks: 1 },
	);
	const first = harness.runTool("browser_task", { task: "one" });
	await inside;
	expect(await harness.runTool("browser_task", { task: "two" })).toContain(
		"1 browser tasks are already running",
	);
	release();
	expect(await first).toBe("ok");
	expect(await harness.runTool("browser_task", { task: "three" })).toBe("ok");
});

test("a driver that fails to start fails the call and leaves nothing to clean", async () => {
	const driver = fakeDriver();
	driver.start = async () => {
		throw new BrowserToolError("no browser today");
	};
	const { harness } = await open(async () => "never", {}, driver);
	await expect(harness.runTool("browser_task", { task: "t" })).rejects.toThrow(
		"no browser today",
	);
});

test("a failed cleanup is logged, not thrown over the report", async () => {
	const { harness, driver } = await open(
		async () => "report",
		{},
		fakeDriver({ disposeFails: true }),
	);
	expect(await harness.runTool("browser_task", { task: "t" })).toBe("report");
	expect(driver.disposed).toBe(1);
});

test("a bad start page is refused before any browser starts", async () => {
	const { harness, driver } = await open(async () => "never");
	expect(
		await harness.runTool("browser_task", {
			task: "t",
			url: "file:///etc/passwd",
		}),
	).toContain("url must start with http");
	expect(
		await harness.runTool("browser_task", { task: "t", url: "not a url" }),
	).toContain("full http or https address");
	expect(driver.started).toBe(0);
});

test("setup fails when the driver's check does, and the options are checked at once", async () => {
	await expect(
		testPlugin(
			browserAgent({
				driver: fakeDriver({
					check: async () => {
						throw new PluginError("Docker is missing; install it");
					},
				}),
			}),
			{
				services: [
					servicePair(
						WORKER_SESSIONS,
						scriptedSessions(async () => ""),
					),
				],
			},
		),
	).rejects.toThrow("Docker is missing; install it");
	expect(() => browserAgent({ limits: { maxSteps: 0 } })).toThrow(
		/limits\.maxSteps must be a whole number from 1 to 500/,
	);
	expect(() => browserAgent({ limits: { timeoutMs: 1.5 } })).toThrow(
		PluginError,
	);
	expect(() =>
		browserAgent({ limits: { maxScreenshotBytes: 11 * 1024 * 1024 } }),
	).toThrow(/maxScreenshotBytes/);
	expect(() => browserAgent({ maxConcurrentTasks: 0 })).toThrow(PluginError);
	expect(() => browserAgent({ model: "no-slash" })).toThrow(
		/model must be provider\/model-id/,
	);
});

test("a surface that cannot carry files costs the screenshots, not the report", async () => {
	const sessions = scriptedSessions(async (worker) => {
		await worker.call("browser_shot");
		return "the report";
	});
	const harness = await testPlugin(browserAgent({ driver: fakeDriver() }), {
		services: [servicePair(WORKER_SESSIONS, sessions)],
		surfaces: [Object.assign(new FilesSurface(), { supportsFiles: false })],
	});
	const text = await harness.runTool("browser_task", { task: "t" });
	expect(text).toStartWith("the report");
	expect(text).toContain("Screenshot 1 could not be attached");
	expect(harness.files).toHaveLength(0);
});

test("the screenshot limits cannot be set past what the core attaches", () => {
	expect(REPLY_FILE_LIMITS.maxFileBytes).toBe(10 * 1024 * 1024);
	expect(() =>
		browserAgent({
			limits: { maxScreenshotBytes: REPLY_FILE_LIMITS.maxFileBytes },
		}),
	).not.toThrow();
});
