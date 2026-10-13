import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundMessage } from "../domain/conversation.ts";
import { silentLogger } from "../log.ts";
import { attachmentsOf } from "./turn-attachments.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const ref = (name: string) => ({
	url: `https://example.test/${name}`,
	name,
	size: 1,
	contentType: "text/plain",
});

function message(): InboundMessage {
	return {
		messageId: "m1",
		attachments: [ref("a.txt"), ref("b.txt")],
		reference: { attachments: [ref("c.txt")] },
	} as unknown as InboundMessage;
}

test("one deadline covers the message and its reference: files still to come fail as download failed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "turn-attachments-"));
	dirs.push(dir);
	let calls = 0;
	const slow = Object.assign(
		async (_url: unknown, init?: RequestInit) => {
			calls += 1;
			await new Promise((resolve) => setTimeout(resolve, 80));
			init?.signal?.throwIfAborted();
			return new Response("x");
		},
		{ preconnect: fetch.preconnect },
	) as unknown as typeof fetch;
	const result = await attachmentsOf(message(), dir, silentLogger(), slow, {
		deadlineMs: 100,
	});
	expect(result.files.length).toBeLessThan(3);
	expect(result.failures.length).toBeGreaterThan(0);
	expect(result.files.length + result.failures.length).toBe(3);
	expect(calls).toBeLessThan(3);
	for (const failure of result.failures)
		expect(failure.reason).toContain("download failed");
});

test("a caller's signal aborts the downloads too", async () => {
	const dir = mkdtempSync(join(tmpdir(), "turn-attachments-"));
	dirs.push(dir);
	const controller = new AbortController();
	controller.abort();
	const result = await attachmentsOf(
		message(),
		dir,
		silentLogger(),
		Object.assign(async () => new Response("x"), {
			preconnect: fetch.preconnect,
		}),
		{ signal: controller.signal },
	);
	expect(result.files).toEqual([]);
	expect(result.failures).toHaveLength(3);
});

test("the deadline's signal reaches fetch: a fetch that only ends on abort lets a file finish within the deadline", async () => {
	const dir = mkdtempSync(join(tmpdir(), "turn-attachments-"));
	dirs.push(dir);
	const hanging = Object.assign(
		(_url: unknown, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) return;
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			}),
		{ preconnect: fetch.preconnect },
	) as unknown as typeof fetch;
	const single = {
		messageId: "m2",
		attachments: [ref("a.txt")],
	} as unknown as InboundMessage;
	const started = Date.now();
	const result = await attachmentsOf(single, dir, silentLogger(), hanging, {
		deadlineMs: 100,
	});
	expect(Date.now() - started).toBeLessThan(2_000);
	expect(result.files).toEqual([]);
	expect(result.failures).toHaveLength(1);
	expect(result.failures[0]?.reason).toContain("download failed");
});
