import type { TurnAttachments } from "../domain/attachment.ts";
import type {
	ChannelKey,
	PendingConfirmation,
	TurnResult,
} from "../domain/conversation.ts";
import { AgentError } from "../domain/errors.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import type { Speaker } from "../identity/speakers.ts";
import { isQuiet, replyBody } from "../presentation/reply-body.ts";
import { endOf, settleTurn } from "../routing/settle-turn.ts";
import { toolTiers } from "../runtime/tool-tiers.ts";
import { withReplyFiles } from "../shared/reply-files.ts";
import { AgentMessages } from "./agent-messages.ts";
import type { Agent } from "./agent-store.ts";
import { GroupTurns } from "./group-turns.ts";
import { HelperWork } from "./helper-work.ts";
import { roomProgress } from "./room-progress.ts";
import { type Routes, routesOf } from "./routes.ts";
import { mayApprove } from "./team-approval.ts";
import { coordinatorOf } from "./team-keys.ts";
import { TeamPosts } from "./team-posts.ts";
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
	readonly routes: Routes;
	/** What keeps each temp knight working, and so when it is finished. */
	readonly helpers: HelperWork;
	/** The chain of each running turn, by session key, read by message_agent. */
	readonly #chains = new Map<ChannelKey, Chain>();
	/** The channel each working agent's turn posts in. */
	readonly #working = new Map<string, ChannelKey>();
	/** The channel each running turn posts in, by session key; a seat's turns run in its group's room. */
	readonly #posting = new Map<ChannelKey, ChannelKey>();
	/** When each agent or group (by `group:<name>`) last started or ended a turn. */
	readonly #lastActive = new Map<string, Date>();

	readonly #posts: TeamPosts;
	readonly #messages: AgentMessages;
	readonly #groups: GroupTurns;

	constructor(options: TeamTurnsOptions) {
		this.#options = options;
		this.routes = routesOf(options);
		this.#posts = new TeamPosts(options);
		this.helpers = new HelperWork({
			store: options.store,
			places: options.places,
			queue: options.queue,
			runtime: options.runtime,
			changed: () => options.changed(),
			logger: options.logger,
		});
		const host: TurnHost = {
			options,
			routes: this.routes,
			helpers: this.helpers,
			chains: this.#chains,
			turn: (agent, scope, postTo, text, chain, extra) =>
				this.#turn(agent, scope, postTo, text, chain, extra),
			post: (channel, as, body) => this.#posts.post(channel, as, body),
			current: (agent) => this.#current(agent),
			mayApprove: (speaker, pending) => this.#mayApprove(speaker, pending),
			turnChannel: (scope) => this.turnChannel(scope),
			chunks: (channel, text) => this.#posts.chunks(channel, text),
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
		const scope = this.#options.places.scopeOf(agent, channel);
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
			this.#options.places.scopeOf(agent, channel),
			channel,
			text,
			{ messages: 0, speaker },
			{
				...(interactive ? { interactive: true } : { unattended: true }),
				...(timeLimitMs === undefined ? {} : { timeLimitMs }),
			},
		);
	}

	#mayApprove(speaker: Speaker, pending: PendingConfirmation): boolean {
		return mayApprove(this.#options.toolTiers ?? toolTiers(), speaker, pending);
	}

	/** The agent whose place it is. */
	#agentOf(channel: ChannelKey): Agent {
		const agent = this.#options.places.agentOf(channel);
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
		// A temp knight is working for as long as a turn of it runs.
		this.helpers.begin(agent.name);
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
		const interim = this.#posts.interim(postTo, agent);
		const progress = roomProgress(this.#options, postTo);
		let result: TurnResult;
		try {
			result = await settleTurn(
				() =>
					withReplyFiles(this.#posts.carriesFiles(postTo), () =>
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
			this.helpers.end(agent.name);
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
			else {
				const body = replyBody(result, this.#posts.support(postTo));
				await this.#posts.post(postTo, this.#current(agent), body);
			}
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
	 * Posts text under the caller's name in the channel of its turn: the group's in a group
	 * round, otherwise its own, as a change report is.
	 */
	async postAs(caller: AgentTurnScope, text: string): Promise<void> {
		const agent = this.#options.store.activeAgent(caller.name);
		const channel = this.turnChannel(caller);
		const chunks = this.#posts.chunks(channel, text);
		await this.#posts.post(channel, this.#current(agent), { chunks });
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
			this.#options.places.seatChannel(group, scope)
		);
	}

	/**
	 * The assistant's own notice, such as a new release, posted in the coordinator's channel under
	 * its name: the entry channel, or, without one, its place on the first surface that has one.
	 */
	async announce(text: string): Promise<void> {
		const { store, places, entryChannel } = this.#options;
		const coordinator = coordinatorOf(store, places, this.#options);
		if (!coordinator)
			throw new AgentError(
				entryChannel === undefined
					? "no active coordinator"
					: "no active agent in the entry channel",
			);
		const home =
			entryChannel !== undefined
				? entryChannel
				: this.routes.primary(coordinator.name);
		if (!home)
			throw new AgentError(`${coordinator.name} has no room to post in`);
		await this.#posts.post(home, coordinator, {
			chunks: this.#posts.chunks(home, text),
		});
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
	/** Ends the group channel's running round on Stop: the sessions to stop, or undefined when none runs. */
	readonly stopRound = (channel: ChannelKey) => this.#groups.stopRound(channel);
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
