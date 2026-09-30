import pino, { type Logger } from "pino";

export type { Logger };

/** One log line as pino writes it: `level`, `time`, `msg`, `err`, and the logged fields. */
export type LogEntry = Record<string, unknown>;

/**
 * JSON lines on stdout, each tagged with `app`, which journald keeps on the host. `onError`,
 * when given, also receives every `error` and `fatal` entry; it must not throw.
 */
export function createLogger(
	app: string,
	onError?: (entry: LogEntry) => void,
): Logger {
	const options = {
		base: { app },
		level: process.env.LOG_LEVEL ?? "info",
	};
	if (!onError) return pino(options);
	return pino(
		options,
		pino.multistream([
			// The logger's own level filters; this stream takes whatever passes it.
			{ level: "trace", stream: pino.destination(1) },
			{
				level: "error",
				stream: {
					write(line: string) {
						try {
							onError(JSON.parse(line) as LogEntry);
						} catch {
							// A broken sink never breaks logging.
						}
					},
				},
			},
		]),
	);
}

/** A logger that drops everything, for tests. */
export function silentLogger(): Logger {
	return pino({ level: "silent" });
}
