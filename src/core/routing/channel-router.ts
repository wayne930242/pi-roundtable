import {
	type Admission,
	type BackgroundRunsAs,
	type BackgroundTarget,
	type BackgroundTurn,
	type ChannelClaim,
	type ConversationPort,
	type InboundMessage,
	QUEUED_MARK,
	type QueuedBy,
	type QueuedChange,
	type QueuedMessage,
	type ScheduledOutcome,
	STEERED_MARK,
} from "../contract/channels.ts";
import type { SurfacePort } from "../contract/surface.ts";
import type { ChannelKey } from "../domain/sessions.ts";
import type { ContactAssessor } from "../identity/contact.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import { HostStoppingError, PluginError } from "../kernel/errors.ts";
import type { Logger } from "../kernel/log.ts";
import { admitMessage } from "./admit-message.ts";
import { speakerOf } from "./background-speaker.ts";
import type { ChannelQueue } from "./channel-queue.ts";
import { tellDeleted, tellEdited } from "./claim-events.ts";
import { ForwardJoin } from "./forward-join.ts";
import type { MessageObservers } from "./message-observers.ts";
import { type PeerBots, peerFacts } from "./peer-bots.ts";
import {
	type QueuedEntry,
	QueuedMessages,
	type RefuseTally,
} from "./queued-messages.ts";
import { tellStopping } from "./stopping-notice.ts";
import { RunningTurns, underRecord } from "./turn-records.ts";

export interface ChannelRouterOptions {
	/** Claims in registration order; the router orders them by priority. */
	claims: readonly ChannelClaim[];
	queue: ChannelQueue;
	/** The contributed background target of a name, read at use time. */
	targets(name: string): BackgroundTarget | undefined;
	logger: Logger;
	/** Who the authors of messages are; without it, no message carries a speaker. */
	contacts?: ContactAssessor;
	/** Whom a background turn runs as; without it, only the host's own turns run. */
	principals?: Pick<IdentityService, "speakerFor">;
	/**
	 * The surfaces, so a conversation started over is marked in a channel that shows one, and a
	 * message that arrives while the host shuts down is told so; without it, neither is.
	 */
	surfaces?: Pick<SurfacePort, "of"> & Partial<Pick<SurfacePort, "sendReply">>;
	/** How long a bare forward waits for the text sent with it; FORWARD_JOIN_MS by default. */
	forwardJoinMs?: number;
	/** The other bots whose messages are answered like a guest's, with the rounds they get; without it, no bot's. */
	peerBots?: PeerBots;
	/** The plugins' passive listeners; each message that reaches routing in an owned channel is handed to them. */
	observers?: MessageObservers;
	/** The runtime's stop, with which `abort` stops a turn in a channel whose claim has no `stop`. */
	stopTurn?: (channel: ChannelKey) => boolean;
}

/** Claims by descending priority, keeping registration order among equals; refuses a repeated name. */
export function orderClaims(
	claims: readonly ChannelClaim[],
): readonly ChannelClaim[] {
	const names = new Set<string>();
	for (const { name } of claims) {
		if (names.has(name))
			throw new PluginError(`channel claim ${name} is registered twice`);
		names.add(name);
	}
	return claims.toSorted((a, b) => b.priority - a.priority);
}

/** The outcome of a background turn the host did not start because it is shutting down. */
const stopping = (): ScheduledOutcome => ({
	status: "skipped",
	reason: new HostStoppingError().message,
});

/**
 * Routes every conversation operation to the claim that owns its channel, each inside the
 * channel's queue: messages after joining a bare forward to its text, background turns,
 * starting over, and deleting.
 */
export class ChannelRouter implements ConversationPort {
	readonly #options: ChannelRouterOptions;
	readonly #claims: readonly ChannelClaim[];
	readonly #forwards: ForwardJoin;
	/** The messages waiting for their own turn, so one can be cancelled or edited until it starts. */
	readonly #queued: QueuedMessages;
	/** Each channel's messages being admitted, so they reach their claim and the queue in the order they came. */
	readonly #admitting = new Map<ChannelKey, Promise<unknown>>();
	/** The surfaces already warned that their messages carry no actor. */
	readonly #warned = new Set<string>();
	/** The channels already told that the host is restarting, so a burst of messages gets one notice. */
	readonly #told = new Set<ChannelKey>();
	/** The admitted turns running, so a shutdown that cuts one leaves its messages for the next process. */
	readonly #turns = new RunningTurns();

	constructor(options: ChannelRouterOptions) {
		this.#options = options;
		this.#claims = orderClaims(options.claims);
		this.#forwards = new ForwardJoin(options.forwardJoinMs);
		this.#queued = new QueuedMessages(options.logger);
	}

	#owner(channel: ChannelKey, space?: string): ChannelClaim | undefined {
		return this.#claims.find((claim) => claim.owns(channel, space));
	}

	/**
	 * Never rejects; every failure is logged. Resolves when the reply is posted or dropped. A
	 * forward without text waits briefly for the text its author sent with it, and the two make
	 * one turn.
	 */
	handle(message: InboundMessage): Promise<void> {
		return this.#forwards.handle(message, (m) => this.#route(m));
	}

	async #route(given: InboundMessage): Promise<void> {
		// Only the router says a message is a peer bot's or who its speaker is.
		const { peerBot: _peer, speaker: _speaker, ...plain } = given;
		const peers = this.#options.peerBots;
		if (peers && !plain.authorIsBot && !plain.integration)
			peers.personPosted(plain.channel);
		const listed = peers?.lists(plain) === true;
		const message: InboundMessage = listed
			? { ...peerFacts(plain), peerBot: true }
			: plain;
		if (
			!message.text.trim() &&
			message.attachments.length === 0 &&
			!message.forwarded?.text.trim()
		)
			return;
		const claim = this.#owner(message.channel, message.space);
		if (!claim) return;
		// A bot nobody lists is not heard, as it is not answered; a listed peer is, rounds or not.
		if (!message.authorIsBot || message.peerBot || message.integration)
			this.#options.observers?.notify(message);
		const yieldedTo = peers?.yieldsTo(message);
		if (yieldedTo) {
			this.#options.logger.info(
				{ channel: message.channel, bot: yieldedTo },
				"message left to a peer bot: it also addresses a peer this host yields to",
			);
			return;
		}
		const started = await this.#inOrder(message.channel, async () => {
			if (listed && peers?.exhausted(message.channel)) {
				this.#options.logger.info(
					{ channel: message.channel, bot: message.authorId },
					"peer bot message ignored: its rounds in this channel are used up until a person posts",
				);
				return undefined;
			}
			const admitted = await admitMessage(claim, message, {
				logger: this.#options.logger,
				warned: this.#warned,
				...(this.#options.contacts ? { contacts: this.#options.contacts } : {}),
			});
			if (!admitted) return undefined;
			const { admission } = admitted;
			if (listed) peers?.answered(message.channel);
			// Once the host shuts down only the turns already running finish: this one starts nothing.
			if (this.#options.queue.closed) {
				await this.#refuse(message, admission);
				return undefined;
			}
			return this.#start(claim, admitted.message, admission);
		});
		await started?.done;
	}

	/** Runs the channel's admissions one at a time, in the order its messages came. */
	#inOrder<T>(channel: ChannelKey, task: () => Promise<T>): Promise<T> {
		const before = this.#admitting.get(channel) ?? Promise.resolve();
		const run = before.then(task);
		const after = run.catch(() => undefined);
		this.#admitting.set(channel, after);
		void after.then(() => {
			if (this.#admitting.get(channel) === after)
				this.#admitting.delete(channel);
		});
		return run;
	}

	/**
	 * Drops a message the host no longer starts a turn for because it is shutting down, and tells
	 * its channel as `tellStopping` does.
	 */
	async #refuse(message: InboundMessage, admission: Admission): Promise<void> {
		const { logger, surfaces } = this.#options;
		const { channel } = message;
		if (admission.kind === "turn") admission.dropped?.();
		else
			admission.unanswered({
				status: "skipped",
				reason: new HostStoppingError().message,
			});
		logger.info({ channel }, "message not run: the host is shutting down");
		await tellStopping(message, surfaces, this.#told, logger);
	}

	/**
	 * Starts what the claim admitted, in the channel's queue, and returns while it runs: a message
	 * during a turn is first offered to it, then marked as waiting.
	 */
	async #start(
		claim: ChannelClaim,
		message: InboundMessage,
		admission: Admission,
	): Promise<{ done: Promise<void> }> {
		const { queue, logger } = this.#options;
		if (admission.kind === "background") {
			const done = this.background(admission.turn).then((outcome) => {
				if (outcome.status !== "ran") admission.unanswered(outcome);
			});
			return { done };
		}
		const { busy } = admission;
		let waiting: QueuedEntry | undefined;
		// During a turn a message joins it or is marked waiting; unmarkable, it is kept so a shutdown refuses it.
		if (busy && queue.size(message.channel) > 0) {
			const running = this.#turns.running(message.channel);
			if (await busy.steer?.()) {
				// It is answered with that turn, or left with it when a shutdown cuts it.
				if (running) running.messages.push(message);
				else
					logger.warn(
						{ channel: message.channel },
						"message steered into a turn routing did not start; a shutdown that cuts that turn does not refuse it",
					);
				return { done: busy.react(STEERED_MARK) };
			}
			// Listed before the mark is placed, so a delete or cancel during that wait reaches it.
			waiting = this.#queued.add(claim, message, admission);
			await busy.react(QUEUED_MARK);
			if (waiting.cancelled) return { done: Promise.resolve() };
		} else if (queue.size(message.channel) > 0)
			waiting = this.#queued.add(claim, message, admission, false);
		const done = queue
			.run(message.channel, () => {
				if (!waiting) return this.#turns.run(message, () => admission.run());
				// From here no cancel or edit reaches it: the turn has started or it was cancelled before.
				if (!this.#queued.remove(waiting)) return Promise.resolve();
				this.#queued.unmark(waiting);
				const { message: started, admission: admitted } = waiting;
				return this.#turns.run(started, () => admitted.run());
			})
			// pi-lens-ignore: no-unknown-parameters
			.catch(async (error: unknown) => {
				// The host began shutting down while this message waited behind a running turn.
				if (error instanceof HostStoppingError) {
					if (waiting && !this.#queued.remove(waiting)) return undefined;
					if (waiting) this.#queued.unmark(waiting);
					return this.#refuse(
						waiting?.message ?? message,
						waiting?.admission ?? admission,
					);
				}
				logger.error(
					{ channel: message.channel, err: error },
					(waiting?.admission ?? admission).failure,
				);
			});
		return { done };
	}

	/** Marks every admitted turn still running as cut, as the drain limit passes. */
	cutRunning(): void {
		this.#turns.cut();
	}

	/**
	 * Leaves each person's message of every turn cut at the drain limit that did not answer, through
	 * its surface as a refused one is, counting in `tally`; call it once the abort grace is over.
	 */
	async leaveCut(tally: RefuseTally): Promise<void> {
		const { logger, surfaces } = this.#options;
		for (const record of this.#turns.takeCut()) {
			// A bot's or an integration's message is told nothing, so its turn's late answer stays.
			const people = record.messages.filter(
				(message) => !message.authorIsBot && !message.integration,
			);
			// Left only as its channel is told, so one the limit stops before keeps its late answer.
			if (tally.stopped) return;
			if (people.length === 0 || !record.leave()) continue;
			logger.info(
				{ channel: record.messages[0]?.channel },
				"turn cut by the shutdown before it answered; its messages are refused",
			);
			for (const message of people) {
				await tellStopping(message, surfaces, this.#told, logger);
				tally.refused += 1;
			}
		}
	}

	/** Refuses each message still waiting behind a turn after the drain, counting in `tally`. */
	refuseWaiting(tally: RefuseTally): Promise<void> {
		return this.#queued.refuseAll(
			(e) => this.#refuse(e.message, e.admission),
			tally,
		);
	}

	queued(channel: ChannelKey): readonly QueuedMessage[] {
		return this.#queued.list(channel);
	}

	cancelQueued(
		channel: ChannelKey,
		messageId: string,
		by: QueuedBy,
	): QueuedChange {
		return this.#queued.cancel(channel, messageId, by, true);
	}

	editQueued(
		channel: ChannelKey,
		messageId: string,
		by: QueuedBy,
		text: string,
	): QueuedChange {
		return this.#queued.edit(channel, messageId, by, text);
	}

	/** Tells the claim that owns the channel a message was deleted; never rejects, never waits for the channel's queue. */
	messageDeleted(
		channel: ChannelKey,
		messageId: string,
		space?: string,
	): Promise<void> {
		// The surface says it is gone: no author check, no mark to remove; an unmarked one still runs, as ever.
		this.#queued.cancel(channel, messageId, undefined, false);
		return tellDeleted(
			this.#owner(channel, space),
			channel,
			messageId,
			this.#options.logger,
		);
	}

	/** Tells the claim that owns the channel a message was edited; never rejects, never waits for the channel's queue. */
	messageEdited(message: InboundMessage): Promise<void> {
		// Only the author edits a message, so a queued one takes the new text without a check.
		this.#queued.edit(
			message.channel,
			message.messageId,
			undefined,
			message.text,
		);
		return tellEdited(
			this.#owner(message.channel, message.space),
			message,
			this.#options.logger,
		);
	}

	target(name: string): BackgroundTarget | undefined {
		return this.#options.targets(name);
	}

	/**
	 * A turn nobody wrote, run by the channel's claim inside its queue, as the speaker its author
	 * is checked to be; never rejects. A turn whose target no plugin contributes is skipped, never
	 * handed to another target's claim, and so is one whose author may not run it now.
	 */
	background(turn: BackgroundTurn): Promise<ScheduledOutcome> {
		// Not part of a message's turn, even when work that turn started asks for it.
		return underRecord(undefined, () => this.#background(turn));
	}

	async #background(turn: BackgroundTurn): Promise<ScheduledOutcome> {
		if (this.#options.queue.closed) return stopping();
		if (!this.#options.targets(turn.target))
			return {
				status: "skipped",
				reason: `no plugin contributes the background target "${turn.target}"`,
			};
		try {
			return await this.#options.queue.run(turn.channel, async () => {
				const claim = this.#owner(turn.channel);
				if (!claim?.background)
					return {
						status: "skipped",
						reason: "no conversation takes background turns here",
					};
				// Checked as the turn starts, in its place in the queue, so a change meanwhile counts.
				const runs = await this.runsAs(turn);
				if ("skipped" in runs)
					return { status: "skipped", reason: runs.skipped };
				return claim.background({ ...turn, speaker: runs.speaker });
			});
		} catch (error) {
			if (error instanceof HostStoppingError) return stopping();
			return { status: "failed", error: String(error) };
		}
	}

	/**
	 * Who a background turn runs as: the system principal for the host's own turn, at its tier;
	 * otherwise its author's principal, which must exist, be enabled, and hold a tier now, at the
	 * lower of the turn's tier and theirs; and the claim that owns the channel must not refuse it
	 * for that speaker (`backgroundRefusal`). Why not, when it may not run; throws when the identity
	 * service cannot tell.
	 */
	async runsAs(turn: BackgroundTurn): Promise<BackgroundRunsAs> {
		const runs = await speakerOf(turn, this.#options.principals);
		if ("skipped" in runs) return runs;
		// The claim that owns the channel has the last word, so work that must not start for a turn it
		// would skip, such as a schedule's precheck, does not.
		const refusal = this.#owner(turn.channel)?.backgroundRefusal?.({
			...turn,
			speaker: runs.speaker,
		});
		return refusal === undefined ? runs : { skipped: refusal };
	}

	startFresh(channel: ChannelKey): Promise<string> {
		return this.#options.queue.run(channel, async () => {
			const claim = this.#owner(channel);
			if (!claim) throw new Error(`no conversation owns ${channel}`);
			const kind = await claim.startFresh(channel);
			await this.#markFresh(channel);
			return kind;
		});
	}

	/** The restart already counts: a surface that cannot mark it is logged, not failed. */
	async #markFresh(channel: ChannelKey): Promise<void> {
		try {
			await this.#options.surfaces?.of(channel)?.markFresh?.(channel);
		} catch (error) {
			this.#options.logger.warn(
				`could not mark the restart of ${channel}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async deleteConversation(channel: ChannelKey): Promise<"deleted" | "busy"> {
		const { queue } = this.#options;
		const claim = this.#owner(channel);
		const remove = claim?.deleteConversation?.bind(claim);
		if (!remove) throw new Error(`${channel} is not an owner conversation`);
		if (queue.size(channel) > 0) return "busy";
		return queue.run(channel, async () => {
			// A message queued between the check and this task would still be waiting behind it.
			if (queue.size(channel) > 1) return "busy";
			await remove(channel);
			return "deleted";
		});
	}

	/** Asks only the claim that owns the channel; false when none does or it has no `stop`. */
	stop(channel: ChannelKey): boolean {
		return this.#owner(channel)?.stop?.(channel) ?? false;
	}

	/** Stops the channel's running turn as the host shuts down: its claim's `stop`, else the runtime's. */
	abort(channel: ChannelKey): boolean {
		const owner = this.#owner(channel);
		if (owner?.stop) return owner.stop(channel);
		this.#options.logger.info(
			{ channel },
			"shutting down: stopping a turn whose claim has no stop through the runtime",
		);
		return this.#options.stopTurn?.(channel) ?? false;
	}

	postsInPlace(channel: ChannelKey): boolean {
		return this.#owner(channel)?.postsInPlace === true;
	}

	owns(channel: ChannelKey): boolean {
		return this.#owner(channel) !== undefined;
	}

	takesBackground(channel: ChannelKey): boolean {
		return this.#owner(channel)?.background !== undefined;
	}

	takesSystemReports(channel: ChannelKey): boolean {
		const owner = this.#owner(channel);
		return owner !== undefined && owner.takesSystemReports !== false;
	}
}
