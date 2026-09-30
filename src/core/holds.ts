import { PluginError } from "./errors.ts";

/** What a hold rule knows about the session making the call. */
export interface HoldContext {
	/** The shared workspace of a session with a shell; calls reaching outside it may be held. */
	workspace?: string;
}

/**
 * Decides whether a tool call waits for the owner's approval. A rule answers with a short
 * description of what the call would do, or undefined when it has no opinion on the call.
 */
export interface HoldRule {
	name: string;
	describe(
		tool: string,
		input: Record<string, unknown>,
		context: HoldContext,
	): string | undefined;
}

/** The description of a call that must be approved first, or undefined to let it run. */
export type HoldCheck = (
	tool: string,
	input: Record<string, unknown>,
	context: HoldContext,
) => string | undefined;

/** Asks the rules in order; the first description holds the call. */
export function holdChain(rules: readonly HoldRule[]): HoldCheck {
	const names = new Set<string>();
	for (const rule of rules) {
		if (names.has(rule.name))
			throw new PluginError(
				`hold rule ${rule.name} is registered twice. Rename one of the two.`,
			);
		names.add(rule.name);
	}
	return (tool, input, context) => {
		for (const rule of rules) {
			const description = rule.describe(tool, input, context);
			if (description !== undefined) return description;
		}
		return undefined;
	};
}
