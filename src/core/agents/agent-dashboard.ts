import { messages } from "../i18n/index.ts";
import type { Logger } from "../log.ts";
import { thinkingLabel } from "../models.ts";
import { zonedDate, zonedStamp } from "../time.ts";
import type { ContextUse, DashboardBoard } from "./agent-ports.ts";
import type { AgentStatus, GroupStatus, TeamStatus } from "./agent-team.ts";

/** At most one edit this often (spec behavior 50); Discord limits message edits per channel. */
const DASHBOARD_MIN_INTERVAL_MS = 10_000;
/** Refreshed this often regardless, so last-activity times and context use stay current. */
const DASHBOARD_REFRESH_MS = 5 * 60_000;
/** Components V2 allows 4000 characters of text per message. */
const TEXT_BUDGET = 3_800;

/** Configured local time, with the month and day when it is not today's. */
function when(at: Date, now: Date): string {
	const date = zonedDate(at);
	const clock = zonedStamp(at).slice(11);
	return date === zonedDate(now) ? clock : `${date.slice(5)} ${clock}`;
}

const kilo = (tokens: number) => `${Math.round(tokens / 1000)}k`;

function contextText(context: ContextUse | undefined): string {
	const text = messages();
	if (!context) return text.dashContextNone;
	if (context.tokens === null)
		return text.dashContextCompacted(kilo(context.contextWindow));
	const percent = Math.round((context.tokens / context.contextWindow) * 100);
	return text.dashContext(
		kilo(context.tokens),
		kilo(context.contextWindow),
		percent,
	);
}

function agentState(agent: AgentStatus): string {
	const text = messages();
	if (agent.workingIn) return text.dashWorking(agent.workingIn, agent.waiting);
	return agent.waiting > 0 ? text.dashQueued(agent.waiting) : text.dashIdle;
}

function agentBlock(agent: AgentStatus, now: Date): string {
	const channel = agent.channelId ? ` <#${agent.channelId}>` : "";
	const text = messages();
	const last = agent.lastActive
		? text.dashLastActive(when(agent.lastActive, now))
		: text.dashNotActive;
	return [
		`**${agent.displayName}**${channel}`,
		`\`${agent.model}\` · thinking \`${thinkingLabel(agent.thinking)}\``,
		`${agentState(agent)} · ${contextText(agent.context)}`,
		text.dashAgentFooter(agent.schedules, last),
	].join("\n");
}

function groupBlock(group: GroupStatus, now: Date): string {
	const text = messages();
	const state = group.busy > 0 ? text.dashGroupBusy(group.busy) : text.dashIdle;
	const last = group.lastActive
		? text.dashLastActive(when(group.lastActive, now))
		: text.dashNotActive;
	return [
		`**${group.displayName}** <#${group.channelId}>`,
		text.dashGroupMembers(group.members, group.host),
		state,
		`-# ${last}`,
	].join("\n");
}

/** Joins blocks under a heading until the text budget runs out, then says how many were left. */
function listed(heading: string, blocks: string[], budget: number): string {
	let text = heading;
	for (const [index, block] of blocks.entries()) {
		if (text.length + block.length + 2 > budget) {
			return `${text}\n\n${messages().dashMore(blocks.length - index)}`;
		}
		text += `\n\n${block}`;
	}
	return blocks.length > 0 ? text : `${text}\n${messages().dashNone}`;
}

/**
 * The dashboard message: the plugins' lines, such as links, then every active agent and group
 * (spec behavior 49; web app spec behavior 6).
 */
export function dashboardSections(
	status: TeamStatus,
	lines: readonly string[],
	now: Date,
): string[] {
	const text = messages();
	const header = [
		text.dashTitle,
		...lines,
		text.dashUpdated(when(now, now)),
	].join("\n");
	const budget = (TEXT_BUDGET - header.length) / 2;
	return [
		header,
		listed(
			"### Agents",
			status.agents.map((agent) => agentBlock(agent, now)),
			budget,
		),
		listed(
			text.dashGroupsHeading,
			status.groups.map((group) => groupBlock(group, now)),
			budget,
		),
	];
}

export interface AgentDashboardOptions {
	status: () => Promise<TeamStatus>;
	board: DashboardBoard;
	/** The plugins' lines under the title, read at each update. */
	lines: () => readonly string[];
	logger: Logger;
	minIntervalMs?: number;
	refreshMs?: number;
}

/**
 * Keeps the dashboard message current: an update right after `changed()` unless one ran in the
 * last interval, in which case one runs when the interval ends; plus a periodic refresh.
 */
export class AgentDashboard {
	readonly #options: AgentDashboardOptions;
	#lastRun = 0;
	#pending: ReturnType<typeof setTimeout> | undefined;
	#refresh: ReturnType<typeof setInterval> | undefined;
	#running: Promise<void> | undefined;

	constructor(options: AgentDashboardOptions) {
		this.#options = options;
	}

	start(): void {
		this.changed();
		this.#refresh = setInterval(
			() => this.changed(),
			this.#options.refreshMs ?? DASHBOARD_REFRESH_MS,
		);
	}

	stop(): void {
		clearTimeout(this.#pending);
		clearInterval(this.#refresh);
		this.#pending = undefined;
	}

	changed(): void {
		if (this.#pending) return;
		const interval = this.#options.minIntervalMs ?? DASHBOARD_MIN_INTERVAL_MS;
		const wait = Math.max(0, this.#lastRun + interval - Date.now());
		this.#pending = setTimeout(() => {
			this.#pending = undefined;
			void this.#update();
		}, wait);
	}

	/** One update at a time; a change during an update schedules the next one. */
	async #update(): Promise<void> {
		if (this.#running) {
			await this.#running;
			this.changed();
			return;
		}
		this.#lastRun = Date.now();
		this.#running = this.#show().finally(() => {
			this.#running = undefined;
		});
		await this.#running;
	}

	async #show(): Promise<void> {
		const { status, board, lines, logger } = this.#options;
		try {
			await board.show(dashboardSections(await status(), lines(), new Date()));
		} catch (error) {
			logger.warn({ err: error }, "dashboard not updated");
		}
	}
}
