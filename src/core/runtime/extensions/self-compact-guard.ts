import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { ConfigError } from "../../domain/errors.ts";

/** pi-self-compact's tool, active in every session. */
export const COMPACT_TOOL = "compact_session";

/** The preflight's refusal of a session without the tools it requires, saying where compaction's comes from. */
export function missingToolsError(missing: readonly string[]): ConfigError {
	const source = missing.includes(COMPACT_TOOL)
		? ` ${COMPACT_TOOL} comes from the Pi package pi-self-compact: install it (bun add pi-self-compact) and load it from a plugin with piPackages: ["pi-self-compact"], as the plugins/self-compact.ts of a project roundtable init creates does.`
		: "";
	return new ConfigError(
		`required tools are not registered: ${missing.join(", ")}.${source}`,
	);
}

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
