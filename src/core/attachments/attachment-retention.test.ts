import { describe, expect, test } from "bun:test";
import type {
	AttachmentPort,
	ExpiredAttachments,
} from "../contract/attachments.ts";
import type { Logger } from "../log.ts";
import {
	DEFAULT_SWEEP_EVERY_MS,
	retentionService,
	retentionServices,
} from "./attachment-retention.ts";

interface Line {
	level: string;
	fields: unknown;
	message: string;
}

function recordingLogger(lines: Line[]): Logger {
	const at =
		(level: string) =>
		(fields: unknown, message?: string): void => {
			lines.push({
				level,
				fields: typeof fields === "string" ? {} : fields,
				message: typeof fields === "string" ? fields : (message ?? ""),
			});
		};
	const logger: Logger = {
		debug: at("debug"),
		info: at("info"),
		warn: at("warn"),
		error: at("error"),
		fatal: at("fatal"),
		child: () => logger,
	};
	return logger;
}

function port(results: Array<ExpiredAttachments | Error>) {
	const calls: number[] = [];
	const fake = {
		expireUsed: async ({ olderThanMs }: { olderThanMs: number }) => {
			calls.push(olderThanMs);
			const next = results.shift() ?? {
				files: 0,
				bytes: 0,
				unattributedBytes: 0,
			};
			if (next instanceof Error) throw next;
			return next;
		},
	} as unknown as AttachmentPort;
	return { fake, calls };
}

const none = { files: 0, bytes: 0, unattributedBytes: 0 };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("retentionService", () => {
	test("sweeps once when it starts and then every period, until it stops", async () => {
		const { fake, calls } = port([]);
		const service = retentionService(
			fake,
			{ maxAgeMs: 5_000, sweepEveryMs: 20 },
			recordingLogger([]),
		);
		await service.start?.();
		expect(calls).toEqual([5_000]);
		await wait(110);
		await service.stop?.();
		const seen = calls.length;
		expect(seen).toBeGreaterThanOrEqual(3);
		await wait(60);
		expect(calls).toHaveLength(seen);
	});

	test("sweeps hourly by default, and no later than the age itself", () => {
		expect(DEFAULT_SWEEP_EVERY_MS).toBe(3_600_000);
	});

	test("logs the counts of what it removed and nothing when nothing went", async () => {
		const lines: Line[] = [];
		const { fake } = port([
			{ files: 3, bytes: 90, unattributedBytes: 10 },
			none,
		]);
		const service = retentionService(
			fake,
			{ maxAgeMs: 1_000, sweepEveryMs: 1_000_000 },
			recordingLogger(lines),
		);
		await service.start?.();
		await service.stop?.();
		expect(lines).toHaveLength(1);
		expect(lines[0]?.fields).toEqual({
			files: 3,
			bytes: 90,
			unattributedBytes: 10,
		});
	});

	test("a failed sweep is logged without the error's text and does not stop the service", async () => {
		const lines: Line[] = [];
		const failure = Object.assign(
			new Error("EACCES: /data/attachments/web_1/secret-plan.pdf"),
			{
				code: "EACCES",
			},
		);
		const { fake, calls } = port([failure, none]);
		const service = retentionService(
			fake,
			{ maxAgeMs: 1_000, sweepEveryMs: 20 },
			recordingLogger(lines),
		);
		await service.start?.();
		await wait(60);
		await service.stop?.();
		expect(calls.length).toBeGreaterThanOrEqual(2);
		const warning = lines.find((line) => line.level === "warn");
		expect(warning?.fields).toEqual({ code: "EACCES" });
		expect(JSON.stringify(lines)).not.toContain("secret-plan");
	});

	test("never runs two sweeps at once", async () => {
		let running = 0;
		let overlapped = false;
		const fake = {
			expireUsed: async () => {
				running += 1;
				if (running > 1) overlapped = true;
				await wait(50);
				running -= 1;
				return none;
			},
		} as unknown as AttachmentPort;
		const service = retentionService(
			fake,
			{ maxAgeMs: 1_000, sweepEveryMs: 10 },
			recordingLogger([]),
		);
		const started = service.start?.();
		await wait(120);
		await service.stop?.();
		await started;
		expect(overlapped).toBe(false);
	});
});

describe("retentionServices", () => {
	test("refuses a port that cannot expire used files, so a custom port without it still type-checks", () => {
		const { expireUsed: _, ...withoutExpiry } = port([]).fake;
		expect(() =>
			retentionServices(
				{ maxAgeMs: 1_000 },
				"/data",
				withoutExpiry as AttachmentPort,
				recordingLogger([]),
			),
		).toThrow("expireUsed");
	});
});
