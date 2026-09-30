import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** pi-self-compact's tool, active in every session. */
export const COMPACT_TOOL = "compact_session";

const RESUME_REFUSED =
	"compact_session cannot take resume here: a resumed run would start outside this conversation and its reply would reach no one. Finish this turn's work, then call compact_session again without resume; the next message starts from the compacted context.";

/**
 * Refuses `compact_session` with `resume`. A turn starts only from the owner, a schedule, or
 * another agent, so a run pi-self-compact starts on its own would answer no one.
 */
export function selfCompactGuardExtension(): ExtensionFactory {
	return (pi) => {
		pi.on("tool_call", (event) => {
			if (event.toolName !== COMPACT_TOOL) return undefined;
			const { resume } = event.input as { resume?: unknown };
			// pi-self-compact ignores a blank resume, so only a real one is refused.
			if (typeof resume !== "string" || !resume.trim()) return undefined;
			return { block: true, reason: RESUME_REFUSED };
		});
	};
}
