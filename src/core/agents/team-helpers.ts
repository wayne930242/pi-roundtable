import { helpersOf } from "../config/helpers.ts";
import { AgentError } from "../domain/errors.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import { answersTo, helperSurface, isHelper } from "./agent-rules.ts";
import type { Agent } from "./agent-store.ts";
import type { HelpersEnded } from "./helper-ops.ts";
import type { TeamContext } from "./team-options.ts";

/** How often the host looks for finished temp knights past their keep. */
const SWEEP_EVERY_MS = 3_600_000;

/**
 * The team's temp knights after they are made: which a knight has, which are finished, and their
 * archive, restore, and sweep. A temp knight made on Discord lives in a thread of its parent's
 * channel; one made in the web app gets that thread only once someone reaches for it on Discord.
 * Archiving one closes its thread, when it has one; an archived one keeps its history.
 */
export class TeamHelpers {
	readonly #ctx: TeamContext;
	/** Archives one agent as the team archives any: schedules, groups, conversations. */
	readonly #archiveAgent: (agent: Agent) => Promise<void>;
	readonly #ended: ((event: HelpersEnded) => void)[] = [];
	#sweeper: ReturnType<typeof setInterval> | undefined;
	/** The threads being made for web-born temp knights, by name, so two reaches make one. */
	readonly #placing = new Map<string, Promise<void>>();

	constructor(ctx: TeamContext, archiveAgent: (agent: Agent) => Promise<void>) {
		this.#ctx = ctx;
		this.#archiveAgent = archiveAgent;
	}

	onEnded(listener: (event: HelpersEnded) => void): void {
		this.#ended.push(listener);
	}

	/** The active temp knights a knight made. */
	of(parent: string): Agent[] {
		return this.#ctx.options.store.helpersOf(parent, "active");
	}

	/** The active temp knights that are finished, of the named parents or of every knight. */
	finished(parents?: readonly string[]): Agent[] {
		return this.#ctx.options.store
			.agents()
			.filter(
				(agent) =>
					isHelper(agent) &&
					agent.status === "active" &&
					agent.finishedAt !== undefined &&
					(parents === undefined || parents.includes(agent.parent as string)),
			);
	}

	/**
	 * The agent tool: a knight archives its own temp knights, the named ones or every finished one.
	 * Whoever shows the parent's room is told, to offer the undo.
	 */
	async end(
		caller: AgentTurnScope,
		names: readonly string[] | "finished",
	): Promise<string> {
		const mine = this.of(caller.name);
		const wanted =
			names === "finished"
				? mine.filter((agent) => agent.finishedAt !== undefined)
				: names.map((name) => {
						const own = mine.find((agent) => agent.name === name);
						if (!own)
							throw new AgentError(
								`"${name}" is not one of your temp knights; yours: ${mine.map((agent) => agent.name).join(", ") || "none"}.`,
							);
						return own;
					});
		if (wanted.length === 0)
			return "None of your temp knights is finished yet, so none was archived.";
		const archived = await this.archive(wanted.map((agent) => agent.name));
		for (const listener of this.#ended)
			listener({ parent: caller.name, names: archived });
		return `Archived ${archived.length} temp knight${archived.length === 1 ? "" : "s"}: ${archived.join(", ")}. Their history stays readable, and the owner can restore them.`;
	}

	/**
	 * Archives temp knights: each stops answering, keeps its history, and its Discord thread is
	 * closed. Names that are no active temp knight are passed over. Says which were archived.
	 */
	async archive(names: readonly string[]): Promise<string[]> {
		const { store } = this.#ctx.options;
		const archived: string[] = [];
		for (const name of new Set(names)) {
			const agent = store.agent(name);
			if (!agent || !isHelper(agent) || agent.status !== "active") continue;
			await this.archiveOne(agent);
			archived.push(name);
		}
		return archived;
	}

	/** Archives a temp knight and closes its thread, when it has one; a thread that will not close is logged. */
	async archiveOne(agent: Agent): Promise<void> {
		const { channels, logger } = this.#ctx.options;
		await this.#archiveAgent(agent);
		if (!agent.channelId || !channels?.closeThread) return;
		try {
			await channels.closeThread(agent.channelId);
		} catch (error) {
			logger.warn(
				{ agent: agent.name, err: error },
				"temp knight's thread not closed; it stays silent where it is",
			);
		}
	}

	/**
	 * Returns archived temp knights to the active ones, each with its thread open again; a name that
	 * is no archived temp knight of an active parent is passed over, so an undo after another
	 * change restores only what is still there. Says which were restored.
	 */
	async restore(names: readonly string[]): Promise<string[]> {
		const { store } = this.#ctx.options;
		const restored: string[] = [];
		for (const name of new Set(names)) {
			const agent = store.agent(name);
			if (!agent || !isHelper(agent) || agent.status !== "archived") continue;
			if (store.agent(agent.parent as string)?.status !== "active") continue;
			await this.restoreOne(agent);
			restored.push(name);
		}
		return restored;
	}

	/** A `message_agent` call that names "discord" gives a web-born temp knight its thread first. */
	async reach(
		caller: AgentTurnScope,
		to: string,
		conversation?: string,
	): Promise<void> {
		const { store } = this.#ctx.options;
		const { turns } = this.#ctx;
		const target = store.agent(to);
		const speaker = turns.speakerOf(caller);
		if (conversation?.trim() !== "discord" || !target || !speaker) return;
		if (answersTo(target, caller.name, turns.turnChannel(caller), speaker))
			await this.placeOnDiscord(to);
	}

	/**
	 * Gives an active temp knight made in the web app its thread under the parent's channel, the
	 * first time someone reaches for it on Discord. One made on Discord, or before the origin was
	 * kept, already has its place, and a host without Discord threads makes none; never rejects.
	 */
	placeOnDiscord(name: string): Promise<void> {
		const pending = this.#placing.get(name);
		if (pending) return pending;
		const placing = this.#placeOnDiscord(name).finally(() =>
			this.#placing.delete(name),
		);
		this.#placing.set(name, placing);
		return placing;
	}

	async #placeOnDiscord(name: string): Promise<void> {
		const { store, channels, logger } = this.#ctx.options;
		const agent = store.agent(name);
		const surface = helperSurface(agent);
		if (agent?.status !== "active" || agent.channelId) return;
		if (surface === undefined || surface === "discord") return;
		const parent = store.agent(agent.parent as string);
		if (!parent?.channelId || !channels?.createThread) return;
		try {
			const channelId = await channels.createThread(
				parent.channelId,
				agent.displayName,
			);
			await store.updateAgent(name, { channelId });
		} catch (error) {
			logger.warn(
				{ agent: name, err: error },
				"temp knight's thread not made; it stays in its rooms",
			);
			return;
		}
		logger.info(
			{ agent: name, parent: parent.name },
			"temp knight's thread made",
		);
		this.#ctx.changed();
	}

	/**
	 * Restores one archived temp knight: its thread opens again, or a new one is made when the old
	 * is gone. One made in the web app never gets a new thread: its old one reopens, if it had one
	 * that is still there. It comes back finished, with nothing running.
	 */
	async restoreOne(agent: Agent): Promise<void> {
		const { store, channels, logger } = this.#ctx.options;
		const parent = store.agent(agent.parent as string);
		if (parent?.status !== "active")
			throw new AgentError(
				`"${agent.name}" belongs to "${agent.parent}", which is archived; restore it first.`,
			);
		let { channelId } = agent;
		const surface = helperSurface(agent);
		const bornOnDiscord = surface === undefined || surface === "discord";
		if (channels?.createThread && parent.channelId) {
			if (
				channelId &&
				channels.openThread &&
				(await channels.exists(channelId))
			)
				await channels.openThread(channelId);
			else if (bornOnDiscord)
				channelId = await channels.createThread(
					parent.channelId,
					agent.displayName,
				);
		}
		await store.restoreAgent(agent.name, channelId);
		logger.info(
			{ name: agent.name, parent: parent.name },
			"temp knight restored",
		);
		this.#ctx.changed();
	}

	/**
	 * Stamps every temp knight still marked working as finished. Nothing runs when the team starts,
	 * so one marked working was cut off by a stop or a crash and would hold its cap slot for good;
	 * a replayed message makes it work again.
	 */
	async reconcile(): Promise<string[]> {
		const { store } = this.#ctx.options;
		const stale = store
			.agents()
			.filter(
				(agent) =>
					isHelper(agent) &&
					agent.status === "active" &&
					agent.finishedAt === undefined,
			);
		const stamped: string[] = [];
		for (const agent of stale)
			if (await store.setFinished(agent.name, true)) stamped.push(agent.name);
		return stamped;
	}

	/** Archives the temp knights that have been finished for longer than the host keeps them. */
	async sweepFinished(now: Date = new Date()): Promise<string[]> {
		const limits = helpersOf(this.#ctx.options.helpers);
		if (!limits || limits.archiveFinishedAfterHours === false) return [];
		const cutoff = now.getTime() - limits.archiveFinishedAfterHours * 3_600_000;
		const stale = this.finished()
			.filter((agent) => (agent.finishedAt as Date).getTime() <= cutoff)
			.map((agent) => agent.name);
		if (stale.length === 0) return [];
		const archived = await this.archive(stale);
		this.#ctx.options.logger.info(
			{ archived },
			"finished temp knights archived",
		);
		return archived;
	}

	/** Sweeps once now and then every hour, until `stop`. */
	startSweeper(): void {
		const limits = helpersOf(this.#ctx.options.helpers);
		if (!limits || limits.archiveFinishedAfterHours === false) return;
		const run = () =>
			this.sweepFinished().catch((error: unknown) =>
				this.#ctx.options.logger.warn({ err: error }, "temp knights not swept"),
			);
		void run();
		this.#sweeper = setInterval(run, SWEEP_EVERY_MS);
		this.#sweeper.unref();
	}

	stop(): void {
		if (this.#sweeper) clearInterval(this.#sweeper);
		this.#sweeper = undefined;
	}
}
