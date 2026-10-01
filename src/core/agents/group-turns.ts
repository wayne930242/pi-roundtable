import type { TurnAttachments } from "../domain/attachment.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import { AgentError } from "../domain/errors.ts";
import { messages } from "../i18n/index.ts";
import type { Speaker } from "../speakers.ts";
import { groupTurnText } from "./agent-prompt.ts";
import type { Agent } from "./agent-store.ts";
import {
	MAX_ROUND_REPLIES,
	mentionedMembers,
	planRound,
	RECENT_FOR_SCORING,
} from "./group-round.ts";
import { channelIdOf, groupScope, groupSessionKey } from "./team-keys.ts";
import {
	BACKLOG_LIMIT,
	type Chain,
	type TurnExtra,
	type TurnHost,
} from "./team-turn-types.ts";

/** A group channel's rounds: scoring, then the chosen members answer one at a time. */
export class GroupTurns {
	readonly #host: TurnHost;

	constructor(host: TurnHost) {
		this.#host = host;
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
		const group = store.groupByChannel(channelIdOf(channel));
		if (!group) throw new AgentError(`no group owns ${channel}`);
		const members = group.members
			.map((name) => store.agent(name))
			.filter((m): m is Agent => m?.status === "active");
		const recent = await store.recentGroupMessages(
			group.name,
			RECENT_FOR_SCORING,
		);
		await store.appendGroupMessage(group.name, {
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
				groupSessionKey(group, member.name),
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
		let last: Agent | undefined;
		let replies = 0;
		while (queued.length > 0 && replies < MAX_ROUND_REPLIES) {
			// A member may archive the group during the round.
			if (store.group(group.name)?.status !== "active") return;
			const name = queued.shift() as string;
			const member = store.agent(name);
			if (member?.status !== "active") continue;
			const first = !spoken.has(name);
			spoken.add(name);
			const backlog = await store.backlog(group.name, name, BACKLOG_LIMIT);
			// Delivered once the session has the text, so a message never comes twice.
			if (backlog.lastId !== undefined)
				await store.advanceCursor(group.name, name, backlog.lastId);
			// Attachments and a confirmation belong to a member's first turn of the round only.
			const extra: TurnExtra = { interactive: true };
			if (first) {
				extra.attachments = attachments;
				if (approvals.get(name)) extra.confirmed = true;
			}
			const result = await this.#host.turn(
				member,
				groupScope(member, group),
				channel,
				groupTurnText(group, member, backlog),
				chain,
				extra,
			);
			replies += 1;
			last = member;
			if (!result.ok) continue;
			await store.appendGroupMessage(group.name, {
				author: name,
				authorName: this.#host.current(member).displayName,
				text: result.text,
			});
			for (const handoff of mentionedMembers(result.text, members))
				if (handoff !== name && !queued.includes(handoff)) queued.push(handoff);
		}
		if (queued.length > 0 && last)
			await this.#host.post(channel, this.#host.current(last), {
				chunks: [messages().roundLimitNotice],
			});
	}
}
