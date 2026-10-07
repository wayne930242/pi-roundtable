import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { TurnProgress } from "../domain/progress.ts";

/** How long text is joined before it is sent, so a fast stream costs a few events a second. */
export const PROGRESS_INTERVAL_MS = 250;
/** The longest preview of a tool's arguments, ellipsis included. */
export const PROGRESS_PREVIEW_CHARS = 80;

/** One turn's progress as the runtime reports it; every method returns at once and never throws. */
export interface ProgressReporter {
	text(delta: string): void;
	toolStart(id: string, tool: string, args: unknown): void;
	toolEnd(id: string, tool: string, isError: boolean): void;
	/** Reports a session's event: its text deltas and its tools' starts and ends, never the thinking. */
	observe(event: AgentSessionEvent): void;
	/** Sends the text not sent yet; nothing is sent after it. */
	close(): void;
}

export interface ProgressReporterOptions {
	intervalMs?: number;
	/** Runs `run` after `ms`; returns a cancel. Replaceable in tests. */
	setTimer?: (run: () => void, ms: number) => () => void;
}

const realTimer = (run: () => void, ms: number) => {
	const timer = setTimeout(run, ms);
	timer.unref?.();
	return () => clearTimeout(timer);
};

/** One line of a tool's arguments, cut to the preview length; undefined for none. */
export function toolPreview(args: unknown): string | undefined {
	let text: string | undefined;
	try {
		text = args === undefined ? undefined : JSON.stringify(args);
	} catch {
		return undefined;
	}
	if (!text || text === "{}" || text === "[]") return undefined;
	const line = text.replace(/\s+/g, " ");
	return line.length > PROGRESS_PREVIEW_CHARS
		? `${line.slice(0, PROGRESS_PREVIEW_CHARS - 1)}…`
		: line;
}

/**
 * Turns a session's text deltas and tool events into `TurnProgress`. Text is joined and sent at
 * most once per interval, and always before a tool event, so the order the turn wrote in holds.
 * A sink that throws loses that event only.
 */
export function progressReporter(
	sink: (event: TurnProgress) => void,
	options: ProgressReporterOptions = {},
): ProgressReporter {
	const intervalMs = options.intervalMs ?? PROGRESS_INTERVAL_MS;
	const setTimer = options.setTimer ?? realTimer;
	let buffered = "";
	let cancel: (() => void) | undefined;
	let closed = false;
	const send = (event: TurnProgress) => {
		try {
			sink(event);
		} catch {
			// The surface's failure is its own; the turn goes on without that event.
		}
	};
	const flush = () => {
		cancel?.();
		cancel = undefined;
		if (buffered === "") return;
		const delta = buffered;
		buffered = "";
		send({ type: "text", delta });
	};
	const reporter: ProgressReporter = {
		observe(event) {
			if (
				event.type === "message_update" &&
				event.assistantMessageEvent.type === "text_delta"
			)
				reporter.text(event.assistantMessageEvent.delta);
			else if (event.type === "tool_execution_start")
				reporter.toolStart(event.toolCallId, event.toolName, event.args);
			else if (event.type === "tool_execution_end")
				reporter.toolEnd(event.toolCallId, event.toolName, event.isError);
		},
		text(delta) {
			if (closed || delta === "") return;
			buffered += delta;
			cancel ??= setTimer(flush, intervalMs);
		},
		toolStart(id, tool, args) {
			if (closed) return;
			flush();
			const preview = toolPreview(args);
			send({
				type: "tool_start",
				id,
				tool,
				...(preview === undefined ? {} : { preview }),
			});
		},
		toolEnd(id, tool, isError) {
			if (closed) return;
			flush();
			send({ type: "tool_end", id, tool, ok: !isError });
		},
		close() {
			if (closed) return;
			flush();
			closed = true;
		},
	};
	return reporter;
}
