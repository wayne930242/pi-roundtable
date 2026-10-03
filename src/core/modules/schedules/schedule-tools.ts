import type { BackgroundTarget } from "../../contract/channels.ts";
import type { ChannelKey } from "../../domain/conversation.ts";
import { ScheduleError } from "../../domain/errors.ts";
import { messages } from "../../i18n/index.ts";
import type { ScheduleStore } from "../../services.ts";
import type { ScheduleToolName } from "../../shared/schedule-tools.ts";
import { type Tier, tierAtLeast } from "../../speakers.ts";
import { timeZone, zonedStamp } from "../../time.ts";
import type { PrecheckFinding, PrecheckRegistry } from "./prechecks.ts";
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
const DAY_MS = 86_400_000;

export interface ScheduleToolContext {
	store: Pick<
		ScheduleStore,
		"create" | "get" | "forChannel" | "update" | "remove"
	>;
	channel: ChannelKey;
	/** Whose schedules these are; its `schedules` limits apply, and without them nothing is scheduled. */
	target: BackgroundTarget;
	/** Who asked, recorded on created schedules; a scheduled run speaks for its creator. */
	author: { id: string; name: string; tier?: Tier };
	now: Date;
	/** The host's prechecks a schedule may name; without them, none can be attached. */
	prechecks?: Pick<PrecheckRegistry, "get" | "list">;
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

/** The prechecks a schedule may name, for schedule_list; empty when the host registers none. */
function precheckCatalog(ctx: ScheduleToolContext): string {
	const all = ctx.prechecks?.list() ?? [];
	if (all.length === 0) return "";
	return `\n\nPrechecks you can attach with precheck on schedule_create or schedule_update; the host runs one before each turn and wakes you only when it finds something:\n${all.map((p) => `- ${p.name}: ${p.description.replace(/\n/g, " ")}`).join("\n")}`;
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
	const precheck = schedule.precheck ? `; precheck ${schedule.precheck}` : "";
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
	if (ctx.author.tier && !tierAtLeast(ctx.author.tier, schedule.createdTier))
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
			const title = text(input, "title", TITLE_CHARS);
			const prompt = text(input, "prompt", limits.promptChars);
			const [recurrence, next] = timing(ctx, input);
			const precheck =
				input.precheck === undefined || input.precheck === null
					? undefined
					: precheckName(ctx, input.precheck);
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
				createdById: ctx.author.id,
				createdByName: ctx.author.name,
				createdTier: ctx.author.tier ?? "owner",
				...(precheck ? { precheck } : {}),
			});
			const checked = precheck ? `; precheck ${precheck} runs first` : "";
			return `Scheduled #${created.id} "${title}": ${describeRecurrence(recurrence)}, first run ${zonedStamp(next)} ${messages().zoneTime(timeZone())}${checked}.`;
		}
		case "schedule_list": {
			if (input.id !== undefined) {
				const schedule = await own(ctx, input);
				return `${line(schedule).split("\n")[0]}\n\nPrompt:\n${schedule.prompt}`;
			}
			const all = await ctx.store.forChannel(ctx.channel);
			const listed =
				all.length === 0
					? "This channel has no schedules."
					: `It is ${zonedStamp(ctx.now)} in ${messages().zoneName(timeZone())}.\n${all.map(line).join("\n")}`;
			return `${listed}${precheckCatalog(ctx)}`;
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
			// null removes the precheck; a name must be registered.
			if (input.precheck !== undefined)
				change.precheck =
					input.precheck === null ? null : precheckName(ctx, input.precheck);
			if (Object.keys(change).length === 0)
				throw new ScheduleError(
					"give a title, prompt, timing, or precheck to change",
				);
			const updated = await ctx.store.update(ctx.channel, schedule.id, change);
			if (!updated) throw new ScheduleError(`schedule #${schedule.id} is gone`);
			const checked = updated.precheck
				? `; precheck ${updated.precheck} runs first`
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
