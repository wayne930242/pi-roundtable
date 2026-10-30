import { channelKey, parseChannelKey } from "../contract/surface.ts";
import type { TurnAttachments } from "../domain/attachment.ts";
import type {
	ChannelKey,
	PendingConfirmation,
	PostAuthor,
	ReplyFile,
	TurnResult,
} from "../domain/conversation.ts";
import { AgentError } from "../domain/errors.ts";
import type { InterimPosts } from "../domain/interim.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import type { TurnProgress } from "../domain/progress.ts";
import { isQuiet, replyBody } from "../presentation/reply-body.ts";
import { splitReply } from "../presentation/reply-splitter.ts";
import { withReplyFiles } from "../reply-files.ts";
import { endOf, settleTurn } from "../routing/settle-turn.ts";
import { mayApproveNamed } from "../runtime/extensions/held-calls.ts";
import { type Speaker, tierAtLeast } from "../speakers.ts";
import { toolTiers } from "../tool-tiers.ts";
import { AgentMessages } from "./agent-messages.ts";
import type { Agent } from "./agent-store.ts";
import { GroupTurns } from "./group-turns.ts";
import {
	agentOfChannel,
	channelIdOf,
	channelOwner,
	coordinatorOf,
	discordIdOf,
	discordKey,
	keysOf,
	roomScope,
	scopeOf,
} from "./team-keys.ts";
import {
	type Chain,
	MAX_CHAIN_MESSAGES,
	type TeamTurnsOptions,
	type TurnExtra,
	type TurnHost,
	turnFlags,
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
	/** The channel each running turn posts in, by session key; a seat's turns run in its group's room. */
	readonly #posting = new Map<ChannelKey, ChannelKey>();
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
	 * The owner's message in an agent's channel; call inside its queue. `text` carries the
	 * reference, `replyText` is what they typed.
	 */
	async answerOwner(
		channel: ChannelKey,
		speaker: Speaker,
		text: string,
		replyText: string,
		attachments: TurnAttachments,
	): Promise<TurnResult> {
		const agent = this.#agentOf(channel);
		const scope = scopeOf(agent, channel);
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
				byMessage: true,
				interactive: true,
			},
		);
	}

	/** A turn no owner message started; call inside its queue. A report turn is interactive. */
	answerBackground(
		channel: ChannelKey,
		speaker: Speaker,
		text: string,
		interactive = false,
		timeLimitMs?: number,
	): Promise<TurnResult> {
		const agent = this.#agentOf(channel);
		return this.#turn(
			agent,
			scopeOf(agent, channel),
			channel,
			text,
			{ messages: 0, speaker },
			{
				...(interactive ? { interactive: true } : { unattended: true }),
				...(timeLimitMs === undefined ? {} : { timeLimitMs }),
			},
		);
	}

	/**
	 * Whether the speaker may approve the held actions by a message, call by call: an owner, as the
	 * agents' channels are shared, or, for a call whose tool named its approvers, one of those
	 * principals, or, for any other call, the principal whose turn held them (by their id, for
	 * actions held before 0.9). Their tier must now hold every call. Nobody else in the channel
	 * may, so a call that named approvers is not its speaker's to approve unless named. The gate
	 * checks the named approvers again when the turn begins, whoever asked for the release.
	 */
	#mayApprove(speaker: Speaker, pending: PendingConfirmation): boolean {
		const theirs =
			pending.principalId !== undefined
				? speaker.principalId === pending.principalId
				: speaker.id === pending.speakerId;
		const tiers = this.#options.toolTiers ?? toolTiers();
		// Nothing held names an approver to go by: only the owners and the speaker whose turn held it.
		if (pending.calls.length === 0) return speaker.tier === "owner" || theirs;
		return pending.calls.every(
			(call) =>
				(speaker.tier === "owner" ||
					(call.approverIds ? mayApproveNamed(speaker, call) : theirs)) &&
				tiers.allows(speaker.tier, call.tool) &&
				(!call.minTier || tierAtLeast(speaker.tier, call.minTier)),
		);
	}

	/** The surfaces that host rooms; none for a team without a surface port. */
	#rooms(channel: ChannelKey): readonly string[] {
		// Only a room key needs the list, which a surface port gives once the hosts are linked.
		return discordIdOf(channel) === undefined
			? (this.#options.surfaces?.roomSurfaces() ?? [])
			: [];
	}

	/** The agent whose channel or room it is. */
	#agentOf(channel: ChannelKey): Agent {
		const { store, surfaces } = this.#options;
		const agent = agentOfChannel(store, surfaces, channel);
		if (agent?.status !== "active")
			throw new AgentError(`no agent owns ${channel}`);
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
		this.#posting.set(scope.session, postTo);
		this.#working.set(agent.name, postTo);
		// A message to the agent lands where it last ran a turn; a group round is none.
		if (!scope.group)
			this.#options.store.conversations.keep(agent.name, postTo, logger);
		this.#active(agent.name, scope.group);
		const turn = {
			agent: agent.name,
			kind: "agent",
			channel: postTo,
			speaker: chain.speaker,
			...(scope.group ? { group: scope.group } : {}),
		};
		this.#options.events?.turnStarted(turn);
		const interim = this.#interim(postTo, agent);
		const progress = this.#progress(postTo);
		let result: TurnResult;
		try {
			result = await settleTurn(
				() =>
					withReplyFiles(this.#carriesFiles(postTo), () =>
						this.#options.runtime().runTurn({
							channel: postTo,
							selection: this.#options.selection(scope),
							text,
							...turnFlags(extra),
							agent: scope,
							speaker: chain.speaker,
							...(interim ? { interim } : {}),
							...(progress ? { progress } : {}),
						}),
					),
				"agent turn",
			);
		} finally {
			hideStop?.();
			this.#chains.delete(scope.session);
			this.#posting.delete(scope.session);
			this.#working.delete(agent.name);
			this.#active(agent.name, scope.group);
		}
		this.#options.events?.turnEnded({
			...turn,
			result: endOf(result),
		});
		try {
			if (!result.ok && !result.stopped) {
				logger.error(
					{ agent: agent.name, channel: postTo, err: result.error },
					"agent turn failed",
				);
			}
			if (isQuiet(result))
				logger.info(
					{ agent: agent.name, channel: postTo },
					"unattended turn had nothing to say; nothing posted",
				);
			else await this.#post(postTo, this.#current(agent), replyBody(result));
		} catch (error) {
			logger.error({ agent: agent.name, err: error }, "agent reply not posted");
		} finally {
			stopTyping();
		}
		return result;
	}

	/**
	 * Whether a reply in the channel may carry files: Discord's webhook posts do; a room only when
	 * its surface declares `supportsFiles`, since a reply with files that surface refuses is lost whole.
	 */
	#carriesFiles(channel: ChannelKey): boolean {
		return (
			discordIdOf(channel) !== undefined ||
			this.#options.surfaces?.of(channel)?.supportsFiles === true
		);
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
	 * What a turn in a room shows as it goes, through the room's surface; none in a Discord
	 * channel, which shows only the final reply, or on a surface that shows no progress.
	 */
	#progress(channel: ChannelKey): ((event: TurnProgress) => void) | undefined {
		const { surfaces, logger } = this.#options;
		if (discordIdOf(channel) !== undefined || !surfaces?.progress)
			return undefined;
		return (event) => {
			// pi-lens-ignore: no-unknown-parameters — a rejection reason is unknown; it only reaches the logger
			surfaces
				.progress?.(channel, event)
				.catch((error: unknown) =>
					logger.warn({ channel, err: error }, "progress not shown"),
				);
		};
	}

	/**
	 * The turn's interim posts under the agent's name, read as each goes out so a name changed
	 * during the turn shows; none in a channel no agent or group owns any more.
	 */
	#interim(channel: ChannelKey, agent: Agent): InterimPosts | undefined {
		const { store, channels, studio, surfaces } = this.#options;
		if (discordIdOf(channel) === undefined) {
			// A room's interim posts are its surface's, under the agent as author.
			if (!surfaces?.interim(channel, this.#author(agent))) return undefined;
			return {
				post: async (text) => {
					if (!channelOwner(store, channel, this.#rooms(channel)))
						throw new AgentError(`${channel} is archived`);
					const posts = surfaces.interim(
						channel,
						this.#author(this.#current(agent)),
					);
					if (!posts) throw new AgentError(`${channel} shows no interim posts`);
					return posts.post(text);
				},
			};
		}
		if (!channels?.interim) return undefined;
		const interim = channels.interim.bind(channels);
		return {
			post: async (text) => {
				if (!channelOwner(store, channel))
					throw new AgentError(`${channel} is archived`);
				const as = this.#current(agent);
				return interim(channelIdOf(channel), {
					name: as.displayName,
					avatarUrl: studio.url(as.avatarHash),
				}).post(text);
			},
		};
	}

	/**
	 * Posts under the agent's name. A channel no agent or group owns any more, archived while a
	 * turn ran, gets nothing, so its webhook is not made again.
	 */
	async #post(
		channel: ChannelKey,
		as: Agent,
		body: {
			thinking?: string;
			chunks: string[];
			files?: ReplyFile[];
			threadId?: string;
			failed?: true;
		},
	): Promise<void> {
		const { store, channels, studio, surfaces, logger } = this.#options;
		if (!channelOwner(store, channel, this.#rooms(channel))) {
			logger.info(
				{ channel, agent: as.name },
				"post to an archived channel dropped",
			);
			return;
		}
		// Discord ignores `failed`.
		const { failed, ...rest } = body;
		if (discordIdOf(channel) === undefined) {
			if (!surfaces)
				throw new AgentError(`no surface serves the room ${channel}`);
			const { thinking, chunks, files, threadId } = rest;
			// A thread of the room's surface is a channel of that surface, and speaks there.
			return surfaces.sendReply(
				threadId === undefined
					? channel
					: channelKey(parseChannelKey(channel).surface, threadId),
				{
					...(thinking ? { thinking } : {}),
					chunks,
					...(files?.length ? { files } : {}),
					author: this.#author(as),
					...(failed ? { failed } : {}),
				},
			);
		}
		if (!channels) throw new AgentError(`no Discord channels serve ${channel}`);
		return channels.post(channelIdOf(channel), {
			name: as.displayName,
			avatarUrl: studio.url(as.avatarHash),
			...rest,
		});
	}

	/** Who speaks for the agent on a surface that shows authors. */
	#author(agent: Agent): PostAuthor {
		return { name: agent.displayName, agent: agent.name };
	}

	/**
	 * Posts text under the caller's name in the channel of its turn: the group's in a group
	 * round, otherwise its own, as a change report is.
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
		if (!group) return scope.home;
		// A seat of a room's group runs in that room; its running turn knows which.
		return (
			this.#posting.get(scope.session) ??
			(group.channelId ? discordKey(group.channelId) : scope.home)
		);
	}

	/**
	 * The assistant's own notice, such as a new release, posted in the coordinator's channel under
	 * its name: the entry channel, or, without Discord, its room on the first surface that hosts rooms.
	 */
	async announce(text: string): Promise<void> {
		const { store, entryChannelId } = this.#options;
		const coordinator = coordinatorOf(store, this.#options);
		if (!coordinator)
			throw new AgentError(
				entryChannelId === undefined
					? "no active coordinator"
					: "no active agent in the entry channel",
			);
		const home =
			entryChannelId !== undefined
				? discordKey(entryChannelId)
				: keysOf(
						store,
						coordinator.name,
						this.#options.surfaces?.roomSurfaces() ?? [],
					)[0];
		if (!home)
			throw new AgentError(`${coordinator.name} has no room to post in`);
		await this.#post(home, coordinator, { chunks: splitReply(text) });
	}

	message(...args: Parameters<AgentMessages["message"]>): string {
		return this.#messages.message(...args);
	}

	/** Delivers the agent messages the last run kept while it stopped; never rejects. */
	replayMessages(): Promise<void> {
		return this.#messages.replay();
	}

	/** What the team still writes that a shutdown must wait for. */
	busy(): string[] {
		return this.#messages.busy();
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
