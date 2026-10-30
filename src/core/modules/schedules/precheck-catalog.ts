import { PRECHECK_SCRIPT_CHARS } from "./prechecks.ts";
import type { ScheduleToolContext } from "./schedule-tools.ts";

/** How long schedule_list waits for the script runner to say what a script may call. */
const DESCRIBE_TIMEOUT_MS = 10_000;

/** The prechecks a schedule may name or write, for schedule_list; empty when the host offers neither. */
export async function precheckCatalog(
	ctx: ScheduleToolContext,
): Promise<string> {
	const all = ctx.prechecks?.list() ?? [];
	const runner = ctx.prechecks?.scriptRunner?.();
	const named =
		all.length === 0
			? ""
			: `\n\nPrechecks you can attach with precheck on schedule_create or schedule_update; the host runs one before each turn and wakes you only when it finds something:\n${all.map((p) => `- ${p.name}: ${p.description.replace(/\n/g, " ")}`).join("\n")}`;
	if (!runner) return named;
	// The list still answers when the host cannot say, or is slow to say, what a script may reach here.
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<string>((resolve) => {
		timer = setTimeout(
			() => resolve("it did not answer in time"),
			DESCRIBE_TIMEOUT_MS,
		);
	});
	const described = Promise.resolve()
		.then(() =>
			runner.describe({
				channel: ctx.channel,
				target: ctx.target.name,
				tier: ctx.author.tier,
			}),
		)
		.then(
			(text) => ({ text }),
			(error: unknown) => ({
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	const answer = await Promise.race([
		described,
		late.then((error) => ({ error })),
	]).finally(() => clearTimeout(timer));
	const guide =
		"text" in answer
			? answer.text
			: `The host could not say what a script may call here (${answer.error}); a script set now may fail when it runs.`;
	return `${named}\n\nYou can write a precheck of your own instead, with precheck_script on schedule_create or schedule_update (null removes it): a JavaScript module, at most ${PRECHECK_SCRIPT_CHARS} characters, that the host runs in a sandbox before each turn. A schedule has a precheck or a precheck_script, not both.\n${guide}`;
}
