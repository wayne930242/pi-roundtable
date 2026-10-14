import type { HeldCall } from "../../domain/conversation.ts";
import type { LateAnswer } from "../../interactions/prompts.ts";
import type { Release } from "./gate-refusals.ts";
import { namedApprover } from "./held-calls.ts";
import type { Watch } from "./withdrawals.ts";

/**
 * What a card answered after its turn stopped waiting comes to: the text of the turn that tells
 * the model, and, for an approval that stands, the release that lets the identical call run once
 * in whichever turn makes it next. Undefined when the answer changes nothing: a question's, a
 * card its plugin withdrew, or an approval by someone the call does not name.
 */
export function lateOutcome(
	call: HeldCall,
	late: LateAnswer,
	watch: Watch | undefined,
): { text: string; release?: Release } | undefined {
	// A card the plugin withdrew answers nothing, whatever a surface that kept it open reports.
	if (watch?.withdrawn || late.kind !== "approval") return undefined;
	if (watch) watch.card = false;
	if (late.approved && !namedApprover(call, late.approvedBy)) return undefined;
	if (!late.approved) {
		watch?.end();
		return {
			text: `(${late.by} declined on its card the action you were waiting on: it would ${call.action}. It did not run; do not make the call again. Go on without it, or ask what ${late.by} wants instead.)`,
		};
	}
	return {
		text: `(${late.by} approved on its card the action you were waiting on: it would ${call.action}. Make this call now with exactly this input, and it runs once; then report its result.)\n- ${call.tool} ${call.input}`,
		release: {
			call,
			...(late.approvedBy ? { by: late.approvedBy } : {}),
			...(late.prompt ? { prompt: late.prompt } : {}),
		},
	};
}
