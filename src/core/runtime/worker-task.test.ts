import { describe, expect, test } from "bun:test";
import { AgentRunError } from "../domain/errors.ts";
import { lastAssistant, textOf } from "../shared/session-messages.ts";
import { MAX_REPORT_CHARS, workerReport } from "./worker-task.ts";

const user = { role: "user", content: "task" };
const answer = (text: string, extra: Record<string, unknown> = {}) => ({
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "hm" },
		{ type: "text", text },
	],
	stopReason: "stop",
	...extra,
});

describe("textOf", () => {
	test("joins text parts and passes a string through", () => {
		expect(
			textOf([
				{ type: "text", text: "a" },
				{ type: "image" },
				{ type: "text", text: "b" },
			]),
		).toBe("a\nb");
		expect(textOf("plain")).toBe("plain");
		expect(textOf(undefined)).toBe("");
	});
});

describe("lastAssistant", () => {
	test("finds the last assistant message", () => {
		const result = lastAssistant([user, answer("first"), answer("second")]);
		expect(result.ok && textOf(result.message.content)).toBe("second");
	});

	test("says why there is no usable answer", () => {
		expect(lastAssistant([user])).toEqual({
			ok: false,
			error: "the run produced no assistant message",
		});
		expect(
			lastAssistant([answer("", { stopReason: "error", errorMessage: "503" })]),
		).toEqual({ ok: false, error: "503" });
		expect(lastAssistant([answer("", { stopReason: "error" })])).toEqual({
			ok: false,
			error: "the run stopped with error",
		});
		expect(lastAssistant([answer("", { stopReason: "aborted" })])).toEqual({
			ok: false,
			error: "the run stopped with aborted",
		});
		expect(
			lastAssistant([answer("", { stopReason: "aborted" })], "timed out"),
		).toEqual({ ok: false, error: "timed out" });
	});
});

describe("workerReport", () => {
	test("returns the trimmed answer", () => {
		expect(workerReport([user, answer("  done  ")], "stopped")).toBe("done");
	});

	test("cuts a long report and says so", () => {
		const report = workerReport(
			[answer("x".repeat(MAX_REPORT_CHARS + 5))],
			"stopped",
		);
		expect(report).toBe(
			`${"x".repeat(MAX_REPORT_CHARS)}\n\n[report cut at ${MAX_REPORT_CHARS} characters]`,
		);
	});

	test("throws AgentRunError without a usable answer", () => {
		expect(() =>
			workerReport([answer("", { stopReason: "aborted" })], "stopped"),
		).toThrow(new AgentRunError("stopped"));
		expect(() => workerReport([answer("   ")], "stopped")).toThrow(
			new AgentRunError("the worker's answer is empty"),
		);
	});
});
