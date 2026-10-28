import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type HoldRule, holdChain } from "../../holds.ts";
import { TEST_OWNER } from "../../testing/owner.ts";
import { ConfirmationGate } from "./confirmation-gate.ts";
import { confirmationGateExtension } from "./confirmation-gate-extension.ts";

type Handler = (
	event: { toolName: string; toolCallId: string; input: unknown },
	ctx: { signal?: AbortSignal },
) => Promise<{ block: true; reason: string } | undefined>;

function handlerFor(rule: HoldRule): Handler {
	const gate = new ConfirmationGate(holdChain([rule]), TEST_OWNER);
	gate.beginTurn("workspace", false);
	let call: Handler | undefined;
	confirmationGateExtension(gate)({
		on: (event: string, h: Handler) => {
			if (event === "tool_call") call = h;
		},
	} as unknown as ExtensionAPI);
	if (!call) throw new Error("missing handler");
	return call;
}

test("a hold rule that throws blocks the call instead of letting it run", async () => {
	const call = handlerFor({
		name: "broken",
		describe: () => {
			throw new Error("rule exploded");
		},
	});
	const result = await call(
		{ toolName: "bash", toolCallId: "c1", input: { command: "ls" } },
		{ signal: new AbortController().signal },
	);
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("rule exploded");
	expect(result?.reason).toContain("not run");
});

test("a call no rule holds still runs", async () => {
	const call = handlerFor({ name: "quiet", describe: () => undefined });
	expect(
		await call(
			{ toolName: "bash", toolCallId: "c2", input: { command: "ls" } },
			{ signal: new AbortController().signal },
		),
	).toBeUndefined();
});
