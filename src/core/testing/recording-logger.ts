import type { Logger } from "../log.ts";

/** One line a recording logger kept. */
export interface RecordedLog {
	level: "debug" | "info" | "warn" | "error" | "fatal";
	/** The fields of the call, with those of every `child` the logger came from. */
	fields: Record<string, unknown>;
	message: string;
}

/** A logger that keeps what it is asked to write, and the lines it kept. */
export interface RecordingLogger {
	readonly logger: Logger;
	/** Every line written through the logger or a child of it, in order. */
	readonly lines: RecordedLog[];
}

/**
 * A logger for a test that checks what the code logs: it writes nowhere, and `lines` holds each
 * call with its level, fields (a child's included), and message.
 */
export function recordingLogger(): RecordingLogger {
	const lines: RecordedLog[] = [];
	const make = (bound: Record<string, unknown>): Logger => {
		const write =
			(level: RecordedLog["level"]) =>
			(first: object | string, message?: string): void => {
				lines.push(
					typeof first === "string"
						? { level, fields: { ...bound }, message: first }
						: { level, fields: { ...bound, ...first }, message: message ?? "" },
				);
			};
		return {
			debug: write("debug"),
			info: write("info"),
			warn: write("warn"),
			error: write("error"),
			fatal: write("fatal"),
			child: (fields) => make({ ...bound, ...fields }),
		};
	};
	return { logger: make({}), lines };
}
