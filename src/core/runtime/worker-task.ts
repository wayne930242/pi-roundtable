import type {
	AgentSession,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { AgentRunError, ConfigError } from "../domain/errors.ts";
import { parseModelRef } from "../models.ts";
import { lastAssistant, textOf } from "../shared/session-messages.ts";

export const MAX_REPORT_CHARS = 20_000;

/**
 * A finished worker's report: its last answer, cut at MAX_REPORT_CHARS. Throws AgentRunError
 * when it has none; `aborted` says why an aborted run stopped.
 */
export function workerReport(
	messages: readonly { role: string }[],
	aborted: string,
): string {
	const last = lastAssistant(messages, aborted);
	if (!last.ok) throw new AgentRunError(last.error);
	const report = textOf(last.message.content).trim();
	if (!report) throw new AgentRunError("the worker's answer is empty");
	return report.length > MAX_REPORT_CHARS
		? `${report.slice(0, MAX_REPORT_CHARS)}\n\n[report cut at ${MAX_REPORT_CHARS} characters]`
		: report;
}

/** The host's model for `<provider>/<id>`; throws ConfigError when it has none. */
export function hostModel(runtime: ModelRuntime, model: string) {
	const ref = parseModelRef(model);
	const resolved = ref && runtime.getModel(ref.provider, ref.id);
	if (!resolved)
		throw new ConfigError(`model ${model} is not available on this host`);
	return resolved;
}

/**
 * Runs one task in a fresh session on the model and returns its report; the signal aborts it.
 * The session is disposed of either way.
 */
export async function runWorkerTask(
	session: AgentSession,
	options: {
		modelRuntime: ModelRuntime;
		/** `<provider>/<id>`. */
		model: string;
		task: string;
		signal: AbortSignal;
		/** Why an aborted run stopped, as the report's error. */
		aborted: string;
	},
): Promise<string> {
	const { modelRuntime, model, task, signal, aborted } = options;
	const onAbort = () => void session.abort();
	signal.addEventListener("abort", onAbort);
	try {
		// Extension providers such as claude-bridge exist only once the session loaded them.
		await session.setModel(hostModel(modelRuntime, model));
		await session.prompt(task);
		return workerReport(session.messages, aborted);
	} finally {
		signal.removeEventListener("abort", onAbort);
		session.dispose();
	}
}
