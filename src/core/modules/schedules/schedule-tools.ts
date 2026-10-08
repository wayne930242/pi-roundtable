import type { BackgroundTarget } from "../../contract/channels.ts";
import type { ChannelKey } from "../../domain/conversation.ts";
import { ScheduleError } from "../../domain/errors.ts";
import type { HoldCheck } from "../../holds.ts";
import { messages } from "../../i18n/index.ts";
import { SYSTEM_PRINCIPAL } from "../../identity/principal-store.ts";
import type { ScheduleStore } from "../../services.ts";
import type { ScheduleToolName } from "../../shared/schedule-tools.ts";
import { type Tier, tierAtLeast } from "../../speakers.ts";
import { timeZone, zonedStamp } from "../../time.ts";
import { type PrecheckTool, precheckScriptTools } from "./precheck-tools.ts";
import {
	PRECHECK_SCRIPT_CHARS,
	type PrecheckFinding,
	type PrecheckRegistry,
} from "./prechecks.ts";
import {
	describeRecurrence,
	nextRun,
	parseRecurrence,
	type Recurrence,
	type RecurrenceInput,
} from "./recurrence.ts";
import type { Schedule } from "./schedule-store.ts";

const TITLE_CHARS = 80;
const LIST_PROMPT_PREVIEW = 200;
/** How long schedule_list waits for the script runner to say what a script may call. */
const DESCRIBE_TIMEOUT_MS = 10_000;
const DAY_MS = 86_400_000;

export interface ScheduleToolContext {
	store: Pick<
		ScheduleStore,
		"create" | "get" | "forChannel" | "update" | "remove"
	>;
	channel: ChannelKey;
	/** Whose schedules these are; its `schedules` limits apply, and without them nothing is scheduled. */
	target: BackgroundTarget;
	/**
	 * Who asked: their principal, recorded as a created schedule's creator, the name it lists, and
	 * the tier its runs ask for; a scheduled run speaks for its creator. The host's own turns,
	 * whose principal is the system's, create none.
	 */
	author: { principalId: string; id: string; name: string; tier: Tier };
	now: Date;
	/**
	 * The host's prechecks a schedule may name, and the runner of the scripts it may carry instead;
	 * without them, none can be attached.
	 */
	prechecks?: Pick<PrecheckRegistry, "get" | "list"> &
		Partial<Pick<PrecheckRegistry, "scriptRunner">>;
	/**
	 * The host's hold rules, which mark the tools a saved script calls that the owner approved.
	 * The approval itself is the confirmation gate's, over this very call.
	 */
	holds?: () => HoldCheck;
}

/** The limits of the context's target; a target without them may not schedule. */
function limitsOf(
	ctx: ScheduleToolContext,
): NonNullable<BackgroundTarget["schedules"]> {
	const { schedules } = ctx.target;
	if (!schedules)
		throw new ScheduleError(
			`schedules are not available for ${ctx.target.name} conversations`,
		);
	return schedules;
}

type Input = Record<string, unknown> & RecurrenceInput;

function text(input: Input, name: string, max: number): string {
	const value = input[name];
	if (typeof value !== "string" || !value.trim())
		throw new ScheduleError(`${name} is required`);
	if (value.length > max)
		throw new ScheduleError(
			`${name} is ${value.length} characters; keep it within ${max}`,
		);
	return value.trim();
}

function id(input: Input): number {
	const value = input.id;
	if (typeof value !== "number" || !Number.isInteger(value))
		throw new ScheduleError("id is required; schedule_list shows the ids");
	return value;
}

/** A registered precheck's name; an unknown one is refused with the names there are. */
function precheckName(ctx: ScheduleToolContext, value: unknown): string {
	const names = (ctx.prechecks?.list() ?? []).map((p) => p.name);
	if (typeof value !== "string" || !value.trim())
		throw new ScheduleError(
			`precheck must be the name of a registered precheck${names.length ? `: ${names.join(", ")}` : "; this host registers none"}`,
		);
	const name = value.trim();
	if (!ctx.prechecks?.get(name))
		throw new ScheduleError(
			names.length
				? `there is no precheck "${name}"; the registered ones are ${names.join(", ")}`
				: `there is no precheck "${name}"; this host registers none`,
		);
	return name;
}

/**
 * A precheck script the host's sandbox runs, with the tools it calls: those the hold rules hold
 * were approved by the owner through the confirmation gate before this call ran. Refused when the
 * host has no runner for scripts.
 */
function precheckScript(
	ctx: ScheduleToolContext,
	value: unknown,
): { script: string; tools: PrecheckTool[] } {
	const runner = ctx.prechecks?.scriptRunner?.();
	if (!runner) {
		const names = (ctx.prechecks?.list() ?? []).map((p) => p.name);
		throw new ScheduleError(
			`this host runs no precheck scripts; ${names.length ? `attach a registered precheck instead: ${names.join(", ")}` : "it registers no prechecks either"}`,
		);
	}
	const script = typeof value === "string" ? value : "";
	const tools = precheckScriptTools(value, {
		toolName: (server, tool) => runner.toolName(server, tool),
		holds: ctx.holds?.() ?? (() => undefined),
	});
	return { script, tools };
}

/** The tools a script may call, the owner's approvals marked. */
function toolsText(tools: readonly PrecheckTool[] | undefined): string {
	if (!tools)
		return "not recorded; saved before tools were, so it must be saved again if it calls a held tool";
	if (tools.length === 0) return "none";
	return tools
		.map(
			(t) =>
				`${t.server}/${t.tool}${t.held ? ` (approved by the owner: ${t.held})` : ""}`,
		)
		.join(", ");
}

/** The prechecks a schedule may name or write, for schedule_list; empty when the host offers neither. */
async function precheckCatalog(ctx: ScheduleToolContext): Promise<string> {
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

function hasTiming(input: Input): boolean {
	return [
		"in_minutes",
		"at",
		"time",
		"every_days",
		"start_date",
		"weekdays",
	].some((name) => input[name] !== undefined);
}

/** The recurrence and its first run, refusing a past or too distant one-time run. */
function timing(ctx: ScheduleToolContext, input: Input): [Recurrence, Date] {
	const recurrence = parseRecurrence(input, ctx.now);
	const next = nextRun(recurrence, ctx.now);
	if (!next)
		throw new ScheduleError(
			`that time has already passed; it is ${zonedStamp(ctx.now)} in ${messages().zoneName(timeZone())} now`,
		);
	const { aheadDays } = limitsOf(ctx);
	if (next.getTime() - ctx.now.getTime() > aheadDays * DAY_MS)
		throw new ScheduleError(`the first run must be within ${aheadDays} days`);
	return [recurrence, next];
}

function line(schedule: Schedule): string {
	const prompt =
		schedule.prompt.length > LIST_PROMPT_PREVIEW
			? `${schedule.prompt.slice(0, LIST_PROMPT_PREVIEW)}…`
			: schedule.prompt;
	const precheck = schedule.precheck
		? `; precheck ${schedule.precheck}`
		: schedule.precheckScript
			? `; precheck script (${schedule.precheckScript.length} characters; tools: ${toolsText(schedule.precheckTools)})`
			: "";
	const last = schedule.lastRun
		? `; last run ${zonedStamp(schedule.lastRun)} (${schedule.lastStatus ?? "?"})`
		: "";
	return `- #${schedule.id} ${schedule.title}: ${describeRecurrence(schedule.recurrence)}, next ${zonedStamp(schedule.nextRun)}; set by ${schedule.createdByName}${precheck}${last}\n  ${prompt.replace(/\n/g, " ")}`;
}

async function own(ctx: ScheduleToolContext, input: Input): Promise<Schedule> {
	const schedule = await ctx.store.get(id(input));
	if (!schedule || schedule.channel !== ctx.channel)
		throw new ScheduleError(
			`this channel has no schedule #${String(input.id)}`,
		);
	return schedule;
}

/** A schedule runs at its creator's tier, so someone of a lower tier may not rewrite it. */
function changeable(ctx: ScheduleToolContext, schedule: Schedule): Schedule {
	if (!tierAtLeast(ctx.author.tier, schedule.createdTier))
		throw new ScheduleError(
			`schedule #${schedule.id} was set by a higher tier; only that tier or above can change it`,
		);
	return schedule;
}

/** Runs one schedule tool against the channel's schedules and returns the answer for the model. */
export async function callScheduleTool(
	ctx: ScheduleToolContext,
	name: ScheduleToolName,
	rawInput: Record<string, unknown>,
): Promise<string> {
	const input = rawInput as Input;
	const limits = limitsOf(ctx);
	switch (name) {
		case "schedule_create": {
			if (ctx.author.principalId === SYSTEM_PRINCIPAL)
				throw new ScheduleError(
					"the host's own turns, such as a report's, set up no schedules; ask the owner to set it up",
				);
			const title = text(input, "title", TITLE_CHARS);
			const prompt = text(input, "prompt", limits.promptChars);
			const [recurrence, next] = timing(ctx, input);
			const given = (name: string) =>
				input[name] !== undefined && input[name] !== null;
			if (given("precheck") && given("precheck_script"))
				throw new ScheduleError("give precheck or precheck_script, not both");
			const precheck = given("precheck")
				? precheckName(ctx, input.precheck)
				: undefined;
			const script = given("precheck_script")
				? precheckScript(ctx, input.precheck_script)
				: undefined;
			const existing = await ctx.store.forChannel(ctx.channel);
			if (existing.length >= limits.perChannel)
				throw new ScheduleError(
					`this channel already has ${existing.length} schedules, the most it may have; cancel one first`,
				);
			const created = await ctx.store.create({
				channel: ctx.channel,
				target: ctx.target.name,
				title,
				prompt,
				recurrence,
				nextRun: next,
				createdById: ctx.author.principalId,
				createdByName: ctx.author.name,
				createdTier: ctx.author.tier,
				...(precheck ? { precheck } : {}),
				...(script
					? { precheckScript: script.script, precheckTools: script.tools }
					: {}),
			});
			const checked = precheck
				? `; precheck ${precheck} runs first`
				: script
					? "; its precheck script runs first"
					: "";
			return `Scheduled #${created.id} "${title}": ${describeRecurrence(recurrence)}, first run ${zonedStamp(next)} ${messages().zoneTime(timeZone())}${checked}.`;
		}
		case "schedule_list": {
			if (input.id !== undefined) {
				const schedule = await own(ctx, input);
				const script = schedule.precheckScript
					? `\n\nPrecheck script:\n${schedule.precheckScript}`
					: "";
				return `${line(schedule).split("\n")[0]}\n\nPrompt:\n${schedule.prompt}${script}`;
			}
			const all = await ctx.store.forChannel(ctx.channel);
			const listed =
				all.length === 0
					? "This channel has no schedules."
					: `It is ${zonedStamp(ctx.now)} in ${messages().zoneName(timeZone())}.\n${all.map(line).join("\n")}`;
			return `${listed}${await precheckCatalog(ctx)}`;
		}
		case "schedule_update": {
			const schedule = changeable(ctx, await own(ctx, input));
			const change: Parameters<ScheduleToolContext["store"]["update"]>[2] = {};
			if (input.title !== undefined)
				change.title = text(input, "title", TITLE_CHARS);
			if (input.prompt !== undefined)
				change.prompt = text(input, "prompt", limits.promptChars);
			if (hasTiming(input)) {
				const [recurrence, next] = timing(ctx, input);
				change.recurrence = recurrence;
				change.nextRun = next;
			}
			// null removes one; a name must be registered, and a script replaces a name and back.
			if (
				input.precheck !== undefined &&
				input.precheck !== null &&
				input.precheck_script !== undefined &&
				input.precheck_script !== null
			)
				throw new ScheduleError("give precheck or precheck_script, not both");
			if (input.precheck !== undefined)
				change.precheck =
					input.precheck === null ? null : precheckName(ctx, input.precheck);
			if (input.precheck_script === null) change.precheckScript = null;
			else if (input.precheck_script !== undefined) {
				const script = precheckScript(ctx, input.precheck_script);
				change.precheckScript = script.script;
				change.precheckTools = script.tools;
			}
			if (change.precheck) change.precheckScript = null;
			if (change.precheckScript) change.precheck = null;
			if (Object.keys(change).length === 0)
				throw new ScheduleError(
					"give a title, prompt, timing, precheck, or precheck_script to change",
				);
			const updated = await ctx.store.update(ctx.channel, schedule.id, change);
			if (!updated) throw new ScheduleError(`schedule #${schedule.id} is gone`);
			const checked = updated.precheck
				? `; precheck ${updated.precheck} runs first`
				: updated.precheckScript
					? "; its precheck script runs first"
					: "";
			return `Updated #${updated.id} "${updated.title}": ${describeRecurrence(updated.recurrence)}, next run ${zonedStamp(updated.nextRun)}${checked}.`;
		}
		case "schedule_cancel": {
			const schedule = changeable(ctx, await own(ctx, input));
			await ctx.store.remove(schedule.id, ctx.channel);
			return `Cancelled #${schedule.id} "${schedule.title}".`;
		}
		default:
			throw new ScheduleError("unknown schedule tool");
	}
}

/** What the schedule's precheck found, or how it failed, under its own heading after the task. */
function findingText(finding: PrecheckFinding): string[] {
	return "error" in finding
		? [
				"",
				`### Precheck failed: ${finding.precheck}`,
				`The precheck that decides whether this task needs you failed, so you were woken anyway: ${finding.error}. Check what it watches yourself, and say so if it needs fixing.`,
			]
		: ["", `### Precheck found (${finding.precheck}):`, finding.context];
}

/** What a scheduled run receives as its message, with what its precheck found when it has one. */
export function scheduledTurnText(
	schedule: Schedule,
	firedAt: Date,
	finding?: PrecheckFinding,
): string {
	return [
		`## Scheduled task #${schedule.id}: ${schedule.title}`,
		`${schedule.createdByName} set this schedule (${describeRecurrence(schedule.recurrence)}). It is due now, ${zonedStamp(firedAt)} ${messages().zoneTime(timeZone())}. Nobody wrote a new message: carry out the task below and write what you would post in this channel. If the task keeps a record for later runs, update it with schedule_update on #${schedule.id}.`,
		"",
		schedule.prompt,
		...(finding ? findingText(finding) : []),
	].join("\n");
}
