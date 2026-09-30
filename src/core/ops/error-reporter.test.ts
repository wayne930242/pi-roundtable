import { describe, expect, test } from "bun:test";
import pino from "pino";
import type { ScheduledOutcome } from "../contract/channels.ts";
import { createLogger, type LogEntry } from "../log.ts";
import type { ChannelKey } from "../sessions.ts";
import { ErrorReporter, fingerprint, reportText } from "./error-reporter.ts";

const HOUR = 3_600_000;

/** The ops agent as the delivery sees it: active with a channel, or not. */
interface OpsAgent {
	status: "active" | "archived";
	channelId?: string;
}

const infra: OpsAgent = { status: "active", channelId: "42" };

function stack(file: string, line: number): string {
	return `Error: boom\n    at run (/opt/app/${file}:${line}:7)\n    at next (/opt/app/node_modules/x/index.js:1:1)`;
}

function entry(msg: string, fields: LogEntry = {}): LogEntry {
	return {
		level: 50,
		time: Date.now(),
		pid: 1,
		hostname: "h",
		app: "roundtable",
		msg,
		...fields,
	};
}

function setup(options: { agent?: OpsAgent; turn?: () => Promise<void> } = {}) {
	let now = 1_000_000;
	const timers: { run: () => void; at: number }[] = [];
	const reporter = new ErrorReporter({
		opsAgent: "infra",
		app: "Roundtable",
		now: () => now,
		setTimer: (run, ms) => timers.push({ run, at: now + ms }),
		ignored: [/expected noise/],
	});
	const posts: { channel: ChannelKey; text: string }[] = [];
	const turns: string[] = [];
	const lines: LogEntry[] = [];
	const logger = pino(
		{ base: { app: "roundtable" } },
		{
			write(line: string) {
				const logged = JSON.parse(line) as LogEntry;
				lines.push(logged);
				reporter.record(logged);
			},
		},
	);
	const agent = "agent" in options ? options.agent : infra;
	const delivery = {
		channelOf: (name: string): ChannelKey | undefined =>
			name === "infra" && agent?.status === "active" && agent.channelId
				? `discord:${agent.channelId}`
				: undefined,
		post: async (channel: ChannelKey, text: string) => {
			posts.push({ channel, text });
		},
		turn: async (_channel: ChannelKey, text: string) => {
			turns.push(text);
			await options.turn?.();
			return { status: "ran" } as ScheduledOutcome;
		},
		logger,
	};
	return {
		reporter,
		delivery,
		posts,
		turns,
		lines,
		logger,
		connect: () => reporter.connect(delivery),
		advance(ms: number) {
			now += ms;
			for (const timer of timers.splice(0))
				if (timer.at <= now) timer.run();
				else timers.push(timer);
		},
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ErrorReporter", () => {
	test("an error is posted in Infra's channel and starts its report turn", async () => {
		const { reporter, connect, posts, turns } = setup();
		connect();
		reporter.record(
			entry("webhook post failed", {
				module: "discord",
				channel: "discord:7",
				err: { type: "Error", message: "boom", stack: stack("src/a.ts", 12) },
			}),
		);
		await settle();
		expect(posts).toHaveLength(1);
		expect(posts[0]?.channel).toBe("discord:42");
		const text = posts[0]?.text ?? "";
		expect(text).toStartWith(
			"Roundtable logged an error: webhook post failed\n",
		);
		expect(text).toContain("app: roundtable · module: discord");
		expect(text).toContain("channel: discord:7");
		expect(text).toContain("at run (/opt/app/src/a.ts:12:7)");
		expect(text).not.toContain("pid");
		expect(turns).toEqual([text]);
	});

	test("a long report is trimmed", () => {
		const text = reportText(
			entry("big", {
				err: { message: "x", stack: `Error: ${"y".repeat(5000)}` },
			}),
			"Roundtable",
		);
		expect(text.length).toBeLessThanOrEqual(1500);
		expect(text).toEndWith("…");
	});

	test("the fingerprint ignores times and ids but not where the error was raised", () => {
		const a = entry("failed", {
			channel: "discord:1",
			err: { stack: stack("src/a.ts", 3) },
		});
		const b = entry("failed", {
			channel: "discord:2",
			time: 5,
			err: { stack: stack("src/a.ts", 3) },
		});
		const c = entry("failed", { err: { stack: stack("src/b.ts", 3) } });
		expect(fingerprint(a)).toBe(fingerprint(b));
		expect(fingerprint(a)).not.toBe(fingerprint(c));
		expect(fingerprint(entry("no stack", { job: 1 }))).toBe(
			fingerprint(entry("no stack", { job: 2 })),
		);
	});

	test("the same error twice in an hour is reported once, and again after it", async () => {
		const { reporter, connect, posts, advance } = setup();
		connect();
		const same = () =>
			entry("failed", { err: { stack: stack("src/a.ts", 3) } });
		reporter.record(same());
		await settle();
		advance(HOUR - 1);
		reporter.record(same());
		await settle();
		expect(posts).toHaveLength(1);
		advance(1);
		reporter.record(same());
		await settle();
		expect(posts).toHaveLength(2);
	});

	test("six distinct errors in an hour make five reports and a later summary", async () => {
		const { reporter, connect, posts, turns, advance } = setup();
		connect();
		for (let i = 0; i < 6; i++) {
			reporter.record(entry(`failure ${i}`));
			advance(60_000);
		}
		reporter.record(entry("failure 5"));
		await settle();
		expect(posts).toHaveLength(5);
		advance(HOUR);
		await settle();
		expect(posts).toHaveLength(6);
		expect(posts[5]?.text).toBe(
			"Roundtable error reports: 2 more errors suppressed: failure 5 (×2)",
		);
		expect(turns).toHaveLength(6);
	});

	test("errors logged while Infra runs an error-report turn are summed up after it", async () => {
		let finish = () => {};
		const running = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const { reporter, connect, posts, logger } = setup({ turn: () => running });
		connect();
		reporter.record(entry("first"));
		await settle();
		reporter.record(entry("during the turn"));
		logger.error("also during the turn");
		await settle();
		expect(posts).toHaveLength(1);
		finish();
		await settle();
		await settle();
		expect(posts).toHaveLength(2);
		expect(posts[1]?.text).toStartWith(
			"Roundtable error reports: 2 more errors suppressed:",
		);
		expect(posts[1]?.text).toContain("during the turn");
		expect(posts[1]?.text).toContain("also during the turn");
		await settle();
		reporter.record(entry("after the turn"));
		await settle();
		expect(posts).toHaveLength(3);
	});

	test("the reporter's own failures are only logged", async () => {
		const { reporter, delivery, lines, turns } = setup();
		delivery.post = async () => {
			throw new Error("discord down");
		};
		delivery.turn = async () => {
			throw new Error("turn broke");
		};
		reporter.connect(delivery);
		reporter.record(entry("first"));
		await settle();
		await settle();
		expect(lines.map((l) => l.msg)).toEqual([
			"error report not posted",
			"error report turn failed",
		]);
		expect(turns).toHaveLength(0);
	});

	test("nothing is reported when Infra is missing or archived", async () => {
		for (const agent of [
			undefined,
			{ ...infra, status: "archived" as const },
		]) {
			const { reporter, connect, posts, turns } = setup({ agent });
			connect();
			reporter.record(entry("failed"));
			await settle();
			expect(posts).toHaveLength(0);
			expect(turns).toHaveLength(0);
		}
	});

	test("warnings and ignored errors are not reported", async () => {
		const { reporter, connect, posts } = setup();
		connect();
		reporter.record({ ...entry("just a warning"), level: 40 });
		reporter.record(entry("some expected noise here"));
		await settle();
		expect(posts).toHaveLength(0);
	});

	test("errors before the agent server is ready wait, the last twenty kept", async () => {
		const { reporter, connect, posts, lines } = setup();
		for (let i = 0; i < 23; i++) reporter.record(entry(`early ${i}`));
		expect(posts).toHaveLength(0);
		connect();
		await settle();
		expect(posts.map((p) => p.text.split("\n")[0])).toEqual(
			[3, 4, 5, 6, 7].map((i) => `Roundtable logged an error: early ${i}`),
		);
		expect(lines[0]).toMatchObject({
			level: 40,
			dropped: 3,
			msg: "early errors dropped before reporting started",
		});
	});
});

describe("createLogger", () => {
	test("hands error and fatal entries to the sink, not warnings", () => {
		const taken: LogEntry[] = [];
		const logger = createLogger("roundtable", (logged) => taken.push(logged));
		logger.level = "error";
		logger.warn("a warning");
		logger.error({ job: 1 }, "an error");
		logger.fatal("fatal");
		expect(taken.map((t) => [t.level, t.msg, t.app])).toEqual([
			[50, "an error", "roundtable"],
			[60, "fatal", "roundtable"],
		]);
		expect(taken[0]?.job).toBe(1);
	});
});
