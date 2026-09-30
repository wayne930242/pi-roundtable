import type { TurnAttachments } from "../domain/attachment.ts";
import type {
	ChannelKey,
	PendingConfirmation,
	TurnResult,
} from "../domain/conversation.ts";
import { AgentError } from "../domain/errors.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import { messages } from "../i18n/index.ts";
import { splitReply } from "../presentation/reply-splitter.ts";
import { thinkingLine } from "../presentation/thinking-line.ts";
import { settleTurn } from "../routing/settle-turn.ts";
import type { Speaker } from "../speakers.ts";
import { toolTiers } from "../tool-tiers.ts";
import { AgentMessages } from "./agent-messages.ts";
import type { Agent } from "./agent-store.ts";
import { GroupTurns } from "./group-turns.ts";
import {
	channelIdOf,
	channelKey,
	channelOwner,
	homeScope,
} from "./team-keys.ts";
import {
	type Chain,
	MAX_CHAIN_MESSAGES,
	type TeamTurnsOptions,
	type TurnExtra,
	type TurnHost,
} from "./team-turn-types.ts";

export { MAX_CHAIN_MESSAGES, type TeamTurnsOptions };

/**
 * The agent team's turns: owner messages, background turns, group rounds, and messages between
 * agents, each posted under the answering agent's name.
 */
export class TeamTurns {
	readonly #options: TeamTurnsOptions;
	/** The chain of each running turn, by session key, read by message_agent. */
	readonly #chains = new Map<ChannelKey, Chain>();
	/** The channel each working agent's turn posts in. */
	readonly #working = new Map<string, ChannelKey>();
	/** When each agent or group (by `group:<name>`) last started or ended a turn. */
	readonly #lastActive = new Map<string, Date>();

	readonly #messages: AgentMessages;
	readonly #groups: GroupTurns;

	constructor(options: TeamTurnsOptions) {
		this.#options = options;
		const host: TurnHost = {
			options,
			chains: this.#chains,
			turn: (agent, scope, postTo, text, chain, extra) =>
				this.#turn(agent, scope, postTo, text, chain, extra),
			post: (channel, as, body) => this.#post(channel, as, body),
			current: (agent) => this.#current(agent),
			mayApprove: (speaker, pending) => this.#mayApprove(speaker, pending),
			turnChannel: (scope) => this.turnChannel(scope),
		};
		this.#messages = new AgentMessages(host);
		this.#groups = new GroupTurns(host);
	}

	/** The channel of the agent's running turn, if it has one. */
	workingIn(agent: string): ChannelKey | undefined {
		return this.#working.get(agent);
	}

	/** Whoever started the run the agent's session is in; undefined outside a turn. */
	speakerOf(scope: AgentTurnScope): Speaker | undefined {
		return this.#chains.get(scope.session)?.speaker;
	}

	lastActive(agent: string): Date | undefined {
		return this.#lastActive.get(agent);
	}

	lastGroupActive(group: string): Date | undefined {
		return this.#lastActive.get(`group:${group}`);
	}

	/**
	 * The owner's message in an agent's channel; call inside the channel's queue. `text`
	 * carries the reference, `replyText` is what he typed.
	 */
	async answerOwner(
		channel: ChannelKey,
		speaker: Speaker,
		text: string,
		replyText: string,
		attachments: TurnAttachments,
	): Promise<TurnResult> {
		const agent = this.#agentOf(channel);
		const scope = homeScope(agent);
		const pending = await this.#options.runtime().heldActions(scope.session);
		const confirmed =
			pending !== undefined &&
			this.#mayApprove(speaker, pending) &&
			(await this.#options.confirmations.approves(pending, replyText));
		return this.#turn(
			agent,
			scope,
			channel,
			text,
			{ messages: 0, speaker },
			{
				attachments,
				confirmed,
				steerable: true,
				interactive: true,
			},
		);
	}

	/**
	 * A turn in an agent's channel that no owner message started; call inside its queue. A report
	 * turn is interactive: it may ask the owner on cards there.
	 */
	answerBackground(
		channel: ChannelKey,
		speaker: Speaker,
		text: string,
		interactive = false,
	): Promise<TurnResult> {
		const agent = this.#agentOf(channel);
		return this.#turn(
			agent,
			homeScope(agent),
			channel,
			text,
			{ messages: 0, speaker },
			interactive ? { interactive: true } : {},
		);
	}

	/** Whether the speaker's tier holds every tool of the held actions. */
	#mayApprove(speaker: Speaker, pending: PendingConfirmation): boolean {
		const tiers = this.#options.toolTiers ?? toolTiers();
		return pending.calls.every((call) => tiers.allows(speaker.tier, call.tool));
	}

	#agentOf(channel: ChannelKey): Agent {
		const agent = this.#options.store.agentByChannel(channelIdOf(channel));
		if (!agent) throw new AgentError(`no agent owns ${channel}`);
		return agent;
	}

	/**
	 * Runs one agent turn and posts its reply, or a failure notice, in `postTo` under the
	 * agent's name. Never rejects.
	 */
	async #turn(
		agent: Agent,
		scope: AgentTurnScope,
		postTo: ChannelKey,
		text: string,
		chain: Chain,
		extra: TurnExtra = {},
	): Promise<TurnResult> {
		const { logger, startTyping, showStop } = this.#options;
		const stopTyping = startTyping(postTo);
		// A group round has several sessions; only an agent's own channel maps to one.
		const hideStop = scope.group ? undefined : showStop(postTo);
		this.#chains.set(scope.session, chain);
		this.#working.set(agent.name, postTo);
		this.#active(agent.name, scope.group);
		const turn = {
			agent: agent.name,
			channel: postTo,
			speaker: chain.speaker,
			...(scope.group ? { group: scope.group } : {}),
		};
		this.#options.events?.turnStarted(turn);
		let result: TurnResult;
		try {
			result = await settleTurn(
				() =>
					this.#options.runtime().runTurn({
						channel: postTo,
						selection: this.#options.selection(scope),
						text,
						...(extra.attachments ? { attachments: extra.attachments } : {}),
						...(extra.confirmed ? { confirmed: true } : {}),
						...(extra.steerable ? { steerable: true } : {}),
						...(extra.interactive ? { interactive: true } : {}),
						agent: scope,
						speaker: chain.speaker,
					}),
				"agent turn",
			);
		} finally {
			hideStop?.();
			this.#chains.delete(scope.session);
			this.#working.delete(agent.name);
			this.#active(agent.name, scope.group);
		}
		this.#options.events?.turnEnded({
			...turn,
			result: result.ok ? "ok" : result.stopped ? "stopped" : "failed",
		});
		try {
			if (!result.ok && !result.stopped) {
				logger.error(
					{ agent: agent.name, channel: postTo, err: result.error },
					"agent turn failed",
				);
			}
			const thinking =
				result.ok && result.thinking
					? thinkingLine(result.thinking)
					: undefined;
			await this.#post(postTo, this.#current(agent), {
				...(thinking ? { thinking } : {}),
				chunks: result.ok
					? splitReply(result.text)
					: [
							result.stopped
								? messages().stoppedNotice
								: messages().failureNotice,
						],
			});
		} catch (error) {
			logger.error({ agent: agent.name, err: error }, "agent reply not posted");
		} finally {
			stopTyping();
		}
		return result;
	}

	#active(agent: string, group: string | undefined): void {
		const now = new Date();
		this.#lastActive.set(agent, now);
		if (group) this.#lastActive.set(`group:${group}`, now);
		this.#options.changed();
	}

	/** The agent's latest row, so a display name or avatar changed during the turn shows. */
	#current(agent: Agent): Agent {
		return this.#options.store.agent(agent.name) ?? agent;
	}

	/**
	 * Posts under the agent's name. A channel no agent or group owns any more, archived while a
	 * turn ran, gets nothing, so its webhook is not made again.
	 */
	async #post(
		channel: ChannelKey,
		as: Agent,
		body: { thinking?: string; chunks: string[]; threadId?: string },
	): Promise<void> {
		const { store, channels, studio, logger } = this.#options;
		if (!channelOwner(store, channel)) {
			logger.info(
				{ channel, agent: as.name },
				"post to an archived channel dropped",
			);
			return;
		}
		return channels.post(channelIdOf(channel), {
			name: as.displayName,
			avatarUrl: studio.url(as.avatarHash),
			...body,
		});
	}

	/**
	 * Posts text under the caller's name in the channel of its turn: the group's in a group
	 * round, otherwise its own, as a change report is (repos-and-skills spec behavior 10).
	 */
	async postAs(caller: AgentTurnScope, text: string): Promise<void> {
		const agent = this.#options.store.activeAgent(caller.name);
		await this.#post(this.turnChannel(caller), this.#current(agent), {
			chunks: splitReply(text),
		});
	}

	/** The channel the scope's turns run in: the group's in a group round, otherwise its own. */
	turnChannel(scope: AgentTurnScope): ChannelKey {
		const group = scope.group
			? this.#options.store.group(scope.group)
			: undefined;
		return group ? channelKey(group.channelId) : scope.home;
	}

	/** The assistant's own notice, such as a new release, posted in the coordinator's channel under its name. */
	async announce(text: string): Promise<void> {
		const { store, entryChannelId } = this.#options;
		const coordinator = store.agentByChannel(entryChannelId);
		if (!coordinator)
			throw new AgentError("no active agent in the entry channel");
		await this.#post(channelKey(entryChannelId), coordinator, {
			chunks: splitReply(text),
		});
	}

	message(caller: AgentTurnScope, to: string, text: string): string {
		return this.#messages.message(caller, to, text);
	}

	/**
	 * One owner message in a group channel: scored, then answered by the chosen members one at
	 * a time, each seeing every group message since its last turn. Call inside the queue.
	 */
	answerGroup(
		channel: ChannelKey,
		speaker: Speaker,
		text: string,
		replyText: string,
		attachments: TurnAttachments,
		repliedToName: string | undefined,
	): Promise<void> {
		return this.#groups.answerGroup(
			channel,
			speaker,
			text,
			replyText,
			attachments,
			repliedToName,
		);
	}
}
