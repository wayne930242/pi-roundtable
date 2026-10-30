import type { TurnAttachments } from "../domain/attachment.ts";
import type { ChannelKey, TurnResult } from "../domain/conversation.ts";
import { AgentError } from "../domain/errors.ts";
import type { RoundEnd, RoundProgress } from "../domain/round.ts";
import { messages } from "../i18n/index.ts";
import type { Speaker } from "../speakers.ts";
import { groupTurnText } from "./agent-prompt.ts";
import type { Agent, AgentGroup } from "./agent-store.ts";
import {
	MAX_ROUND_REPLIES,
	mentionedMembers,
	planRound,
	RECENT_FOR_SCORING,
} from "./group-round.ts";
import {
	groupLogName,
	groupOfChannel,
	groupScope,
	groupSessionKey,
} from "./team-keys.ts";
import {
	BACKLOG_LIMIT,
	type Chain,
	type TurnExtra,
	type TurnHost,
} from "./team-turn-types.ts";

/** A running round, as Stop reaches it: the flag it ends on, and the sessions whose turns it is running. */
interface RunningRound {
	stopped: boolean;
	sessions: Set<ChannelKey>;
}

/** A group channel's rounds: scoring, then the chosen members answer one at a time. */
export class GroupTurns {
	readonly #host: TurnHost;
	/** The round each channel runs now; a channel runs one at a time, inside its queue. */
	readonly #running = new Map<ChannelKey, RunningRound>();

	constructor(host: TurnHost) {
		this.#host = host;
	}

	/** Tells the channel's surface where the round stands; a surface that shows no rounds hears nothing, and a refusal only reaches the log. */
	#tell(channel: ChannelKey, round: RoundProgress): void {
		const { surfaces, logger } = this.#host.options;
		// pi-lens-ignore: no-unknown-parameters — a rejection reason is unknown; it only reaches the logger
		surfaces
			?.groupRound?.(channel, round)
			.catch((error: unknown) =>
				logger.warn({ channel, err: error }, "round not shown"),
			);
	}

	/**
	 * Ends the channel's running round: the member speaking is stopped, and the members still waiting
	 * do not speak. Returns the sessions whose turns the caller must stop, or undefined when no round runs
	 * in the channel.
	 */
	stopRound(channel: ChannelKey): ChannelKey[] | undefined {
		const round = this.#running.get(channel);
		if (!round) return undefined;
		round.stopped = true;
		return [...round.sessions];
	}

	/** The active group whose Discord channel or room the key is. */
	#groupOf(channel: ChannelKey): AgentGroup {
		const { store, surfaces } = this.#host.options;
		const group = groupOfChannel(store, surfaces, channel);
		if (group?.status !== "active")
			throw new AgentError(`no group owns ${channel}`);
		return group;
	}

	/**
	 * One owner message in a group channel: scored, then answered by the chosen members one at
	 * a time, each seeing every group message since its last turn. Call inside the queue.
	 */
	async answerGroup(
		channel: ChannelKey,
		speaker: Speaker,
		text: string,
		replyText: string,
		attachments: TurnAttachments,
		repliedToName: string | undefined,
	): Promise<void> {
		const { store, scorer, confirmations, logger } = this.#host.options;
		const runtime = this.#host.options.runtime();
		const group = this.#groupOf(channel);
		// Each conversation of a group keeps its own log: the Discord channel's under the group's
		// name, a room's under `<group>@<surface>`.
		const log = groupLogName(group, channel);
		const members = group.members
			.map((name) => store.agent(name))
			.filter((m): m is Agent => m?.status === "active");
		const recent = await store.recentGroupMessages(log, RECENT_FOR_SCORING);
		const openedBy = await store.appendGroupMessage(log, {
			author: speaker.tier === "owner" ? "owner" : `human:${speaker.id}`,
			authorName:
				speaker.tier === "owner" ? this.#host.options.owner.name : speaker.name,
			text,
		});

		const forced = new Set(mentionedMembers(replyText, members));
		const repliedTo = members.find((m) => m.displayName === repliedToName);
		if (repliedTo) forced.add(repliedTo.name);
		const approvals = new Map<string, boolean>();
		for (const member of members) {
			const pending = await runtime.heldActions(
				groupSessionKey(group, member.name, channel),
			);
			// Only a speaker whose tier holds the held tools may approve or wake a seat for them.
			if (!pending || !this.#host.mayApprove(speaker, pending)) continue;
			forced.add(member.name);
			approvals.set(
				member.name,
				await confirmations.approves(pending, replyText),
			);
		}
		const scores =
			forced.size === members.length
				? undefined
				: await scorer.score(members, recent, text);
		const order = planRound({
			members: members.map((m) => m.name),
			host: members.some((m) => m.name === group.host)
				? group.host
				: (members[0]?.name ?? group.host),
			scores,
			forced,
		});
		logger.info({ group: group.name, scores, order }, "group round planned");

		const chain: Chain = { messages: 0, speaker };
		const queued = [...order];
		const spoken = new Set<string>();
		const control: RunningRound = { stopped: false, sessions: new Set() };
		this.#running.set(channel, control);
		// The stop button belongs to the round, which ends whole: it is shown until the round ends.
		const hideStop = this.#host.options.showStop(channel);
		const share = (
			state: RoundProgress["state"],
			current: string | undefined,
			ended?: RoundEnd,
		) => {
			// The owner's messages waiting in the channel's queue, not counting this round's own task.
			const waiting = Math.max(this.#host.options.queue.size(channel) - 1, 0);
			this.#tell(channel, {
				id: openedBy,
				state,
				...(current === undefined ? {} : { current }),
				next: [...queued],
				spoken: [...spoken],
				replies,
				limit: MAX_ROUND_REPLIES,
				...(ended === undefined ? {} : { ended }),
				...(waiting > 0 ? { queued: waiting } : {}),
			});
		};
		let last: Agent | undefined;
		let replies = 0;
		let end: RoundEnd = "done";
		try {
			share("running", undefined);
			while (queued.length > 0 && replies < MAX_ROUND_REPLIES) {
				if (control.stopped) {
					end = "stopped";
					break;
				}
				// A member may archive the group during the round.
				if (store.group(group.name)?.status !== "active") {
					queued.length = 0;
					break;
				}
				const name = queued.shift() as string;
				const member = store.agent(name);
				if (member?.status !== "active") continue;
				const first = !spoken.has(name);
				const backlog = await store.backlog(log, name, BACKLOG_LIMIT);
				// Delivered once the session has the text, so a message never comes twice.
				if (backlog.lastId !== undefined)
					await store.advanceCursor(log, name, backlog.lastId);
				// Attachments and a confirmation belong to a member's first turn of the round only.
				const extra: TurnExtra = { interactive: true, byMessage: true };
				if (first) {
					extra.attachments = attachments;
					if (approvals.get(name)) extra.confirmed = true;
				}
				const scope = groupScope(member, group, channel);
				control.sessions.add(scope.session);
				share("running", name);
				let result: TurnResult;
				try {
					result = await this.#host.turn(
						member,
						scope,
						channel,
						groupTurnText(group, member, backlog),
						chain,
						extra,
					);
				} finally {
					control.sessions.delete(scope.session);
				}
				spoken.add(name);
				replies += 1;
				last = member;
				if (control.stopped || (!result.ok && result.stopped)) {
					end = "stopped";
					break;
				}
				if (result.ok) {
					await store.appendGroupMessage(log, {
						author: name,
						authorName: this.#host.current(member).displayName,
						text: result.text,
					});
					for (const handoff of mentionedMembers(result.text, members))
						if (handoff !== name && !queued.includes(handoff))
							queued.push(handoff);
				}
				share("running", undefined);
			}
			if (end !== "stopped" && queued.length > 0) end = "limit";
			if (queued.length > 0 && last)
				await this.#host.post(channel, this.#host.current(last), {
					chunks: [
						end === "stopped"
							? messages().roundStoppedNotice
							: messages().roundLimitNotice,
					],
				});
			if (end === "stopped") queued.length = 0;
		} finally {
			hideStop();
			this.#running.delete(channel);
			share("ended", undefined, end);
		}
	}
}
