import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	COMPACT_TOOL,
	selfCompactGuardExtension,
} from "./self-compact-guard.ts";

type Handler = (event: {
	toolName: string;
	input: unknown;
}) => { block: true; reason: string } | undefined;

function handler(): Handler {
	let registered: Handler | undefined;
	selfCompactGuardExtension()({
		on: (event: string, h: Handler) => {
			if (event === "tool_call") registered = h;
		},
	} as unknown as ExtensionAPI);
	if (!registered) throw new Error("no tool_call handler");
	return registered;
}

describe("selfCompactGuardExtension", () => {
	test("refuses compact_session with resume, with the reason", () => {
		const result = handler()({
			toolName: COMPACT_TOOL,
			input: { resume: "continue the report" },
		});
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("without resume");
	});

	test("lets compact_session without resume, or with a blank one, run", () => {
		const h = handler();
		expect(h({ toolName: COMPACT_TOOL, input: {} })).toBeUndefined();
		expect(
			h({ toolName: COMPACT_TOOL, input: { instructions: "keep paths" } }),
		).toBeUndefined();
		expect(
			h({ toolName: COMPACT_TOOL, input: { resume: "  " } }),
		).toBeUndefined();
	});

	test("ignores other tools", () => {
		expect(
			handler()({ toolName: "bash", input: { resume: "x" } }),
		).toBeUndefined();
	});
});
