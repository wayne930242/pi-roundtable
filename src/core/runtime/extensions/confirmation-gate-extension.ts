import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ToolTurn } from "../../define.ts";
import type { PromptSlot } from "../prompt-slot.ts";
import type { ConfirmationGate, HoldTurn } from "./confirmation-gate.ts";

/**
 * Without a slot, or with an empty one, every call that needs confirmation is held. `turnOf` builds
 * the turn a hold that looks things up receives; without it, such a hold is not asked in a turn.
 */
export function confirmationGateExtension(
	gate: ConfirmationGate,
	slot?: PromptSlot,
	turnOf?: (signal: AbortSignal) => ToolTurn,
): ExtensionFactory {
	return (pi) => {
		/** Calls a card's approval released, until their results are back. */
		const approved = new Set<string>();
		pi.on("tool_result", (event) => {
			gate.finish(event.toolCallId);
			if (!approved.delete(event.toolCallId)) return undefined;
			const outcome = event.isError
				? "It was approved on its card and ran, but it failed:"
				: "It was approved on its card and ran; its result follows.";
			return {
				content: [{ type: "text", text: outcome }, ...event.content],
			};
		});
		pi.on("tool_call", async (event, ctx) => {
			const prompts = slot?.prompts;
			let ask: Parameters<ConfirmationGate["review"]>[2];
			if (prompts && slot) {
				ask = { prompts, asker: slot.asker };
				if (ctx.signal) ask.signal = ctx.signal;
			}
			const turn: HoldTurn | undefined = turnOf
				? { toolTurn: turnOf, ...(ctx.signal ? { signal: ctx.signal } : {}) }
				: undefined;
			const { reason, approvedOnCard, approvedBy, refused } = await gate.decide(
				event.toolName,
				event.input as Record<string, unknown>,
				ask,
				turn,
				// A host that gives no tool list shows the call as JSON.
				pi.getAllTools?.().find((tool) => tool.name === event.toolName)
					?.parameters,
			);
			if (approvedOnCard) approved.add(event.toolCallId);
			if (approvedBy && !reason) gate.grant(event.toolCallId, approvedBy);
			if (refused) slot?.refuse(event.toolCallId, refused);
			return reason ? { block: true, reason } : undefined;
		});
	};
}
