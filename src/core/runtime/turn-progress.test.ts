import { describe, expect, test } from "bun:test";
import type { TurnProgress } from "../domain/progress.ts";
import {
	PROGRESS_PREVIEW_CHARS,
	progressReporter,
	toolPreview,
} from "./turn-progress.ts";

/** A reporter over a clock the test moves, recording what it sends. */
function reporter() {
	const sent: TurnProgress[] = [];
	const timers: { run: () => void; at: number }[] = [];
	let now = 0;
	const progress = progressReporter((event) => void sent.push(event), {
		intervalMs: 250,
		setTimer: (run, ms) => {
			const timer = { run, at: now + ms };
			timers.push(timer);
			return () => {
				timers.splice(timers.indexOf(timer), 1);
			};
		},
	});
	return {
		sent,
		progress,
		advance(ms: number) {
			now += ms;
			for (const timer of [...timers])
				if (timer.at <= now) {
					timers.splice(timers.indexOf(timer), 1);
					timer.run();
				}
		},
		pending: () => timers.length,
	};
}

describe("progressReporter", () => {
	test("text deltas are joined and sent at most once per interval", () => {
		const { sent, progress, advance } = reporter();
		progress.text("Hel");
		progress.text("lo");
		expect(sent).toEqual([]);
		advance(250);
		expect(sent).toEqual([{ type: "text", delta: "Hello" }]);
		progress.text(", world");
		advance(100);
		expect(sent).toHaveLength(1);
		advance(150);
		expect(sent.at(-1)).toEqual({ type: "text", delta: ", world" });
	});

	test("the text so far is sent before a tool starts or ends, so the order holds", () => {
		const { sent, progress, pending } = reporter();
		progress.text("Let me look.");
		progress.toolStart("call-1", "probe", { query: "inn" });
		progress.text("Found");
		progress.toolEnd("call-1", "probe", false);
		expect(sent).toEqual([
			{ type: "text", delta: "Let me look." },
			{
				type: "tool_start",
				id: "call-1",
				tool: "probe",
				preview: '{"query":"inn"}',
			},
			{ type: "text", delta: "Found" },
			{ type: "tool_end", id: "call-1", tool: "probe", ok: true },
		]);
		expect(pending()).toBe(0);
	});

	test("a failed tool ends with ok false", () => {
		const { sent, progress } = reporter();
		progress.toolEnd("call-2", "bash", true);
		expect(sent).toEqual([
			{ type: "tool_end", id: "call-2", tool: "bash", ok: false },
		]);
	});

	test("close sends what is left and nothing after it", () => {
		const { sent, progress, advance, pending } = reporter();
		progress.text("last words");
		progress.close();
		expect(sent).toEqual([{ type: "text", delta: "last words" }]);
		expect(pending()).toBe(0);
		progress.text("too late");
		progress.toolStart("call-3", "probe", {});
		advance(1000);
		expect(sent).toHaveLength(1);
	});

	test("a sink that throws loses that event and never the turn", () => {
		const seen: TurnProgress[] = [];
		const progress = progressReporter(
			(event) => {
				seen.push(event);
				throw new Error("surface gone");
			},
			{ intervalMs: 250, setTimer: () => () => undefined },
		);
		expect(() => progress.toolStart("call-4", "probe", {})).not.toThrow();
		expect(() => progress.close()).not.toThrow();
		expect(seen).toHaveLength(1);
	});
});

describe("toolPreview", () => {
	test("is one line of the arguments, cut to the preview length", () => {
		expect(toolPreview({ path: "a.md" })).toBe('{"path":"a.md"}');
		expect(toolPreview({ text: "one\ntwo" })).toBe('{"text":"one\\ntwo"}');
		const long = toolPreview({ text: "x".repeat(500) });
		expect(long).toHaveLength(PROGRESS_PREVIEW_CHARS);
		expect(long?.endsWith("…")).toBe(true);
	});

	test("is absent for no arguments or ones that cannot be written", () => {
		expect(toolPreview(undefined)).toBeUndefined();
		expect(toolPreview({})).toBeUndefined();
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(toolPreview(cyclic)).toBeUndefined();
	});
});
