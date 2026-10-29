import type { Logger } from "../../log.ts";

/**
 * Reads a prompt for the run that is starting. Pi swallows what a `before_agent_start` handler
 * throws, so a prompt that cannot be read would let the run go on quietly with the prompt the
 * session was built with, or with none at all. The failure is logged as an error and the run is
 * stopped instead; the result is then undefined.
 */
export function readPromptOrStop(
	read: () => string,
	run: { abort(): void },
	logger: Logger,
	what: string,
): string | undefined {
	try {
		return read();
	} catch (error) {
		logger.error({ err: error }, `${what} cannot be read; the run is stopped`);
		run.abort();
		return undefined;
	}
}
