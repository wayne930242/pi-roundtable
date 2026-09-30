import {
	type BackgroundTurn,
	type ChannelClaim,
	type ConversationPort,
	type InboundMessage,
	QUEUED_MARK,
	type ScheduledOutcome,
	STEERED_MARK,
} from "../contract/channels.ts";
import { PluginError } from "../errors.ts";
import type { Logger } from "../log.ts";
import type { ChannelKey } from "../sessions.ts";
import type { ChannelQueue } from "./channel-queue.ts";
import { ForwardJoin } from "./forward-join.ts";

export interface ChannelRouterOptions {
	/** Claims in registration order; the router orders them by priority. */
	claims: readonly ChannelClaim[];
	queue: ChannelQueue;
	/** Stops the channel's running turn; false when none runs. */
	stop(channel: ChannelKey): boolean;
	logger: Logger;
	/** How long a bare forward waits for the text sent with it; FORWARD_JOIN_MS by default. */
	forwardJoinMs?: number;
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

/**
 * Routes every conversation operation to the claim that owns its channel, each inside the
 * channel's queue: messages after joining a bare forward to its text, background turns,
 * starting over, and deleting.
 */
export class ChannelRouter implements ConversationPort {
	readonly #options: ChannelRouterOptions;
	readonly #claims: readonly ChannelClaim[];
	readonly #forwards: ForwardJoin;

	constructor(options: ChannelRouterOptions) {
		this.#options = options;
		this.#claims = orderClaims(options.claims);
		this.#forwards = new ForwardJoin(options.forwardJoinMs);
	}

	#owner(channel: ChannelKey, guildId?: string): ChannelClaim | undefined {
		return this.#claims.find((claim) => claim.owns(channel, guildId));
	}

	/**
	 * Never rejects; every failure is logged. Resolves when the reply is posted or dropped. A
	 * forward without text waits briefly for the text its author sent with it, and the two make
	 * one turn.
	 */
	handle(message: InboundMessage): Promise<void> {
		return this.#forwards.handle(message, (m) => this.#route(m));
	}

	async #route(message: InboundMessage): Promise<void> {
		const { queue, logger } = this.#options;
		if (
			!message.text.trim() &&
			message.attachments.length === 0 &&
			!message.forwarded?.text.trim()
		)
			return;
		const admission = this.#owner(message.channel, message.guildId)?.admit(
			message,
		);
		if (!admission) return;
		if (admission.kind === "background") {
			const outcome = await this.background(admission.turn);
			if (outcome.status !== "ran") admission.unanswered(outcome);
			return;
		}
		const { busy } = admission;
		let queued = false;
		// A message during a turn is added to it when the turn takes it, otherwise marked as waiting.
		if (busy && queue.size(message.channel) > 0) {
			if (await busy.steer?.()) {
				await busy.react(STEERED_MARK);
				return;
			}
			await busy.react(QUEUED_MARK);
			queued = true;
		}
		await queue
			.run(message.channel, () => {
				if (queued) void busy?.unreact(QUEUED_MARK);
				return admission.run();
			})
			// pi-lens-ignore: no-unknown-parameters
			.catch((error: unknown) =>
				logger.error(
					{ channel: message.channel, err: error },
					admission.failure,
				),
			);
	}

	/** A turn nobody wrote, run by the channel's claim inside its queue; never rejects. */
	async background(turn: BackgroundTurn): Promise<ScheduledOutcome> {
		try {
			return await this.#options.queue.run(turn.channel, async () => {
				const claim = this.#owner(turn.channel);
				if (!claim?.background)
					return {
						status: "skipped",
						reason: "no conversation takes background turns here",
					};
				return claim.background(turn);
			});
		} catch (error) {
			return { status: "failed", error: String(error) };
		}
	}

	startFresh(channel: ChannelKey): Promise<string> {
		return this.#options.queue.run(channel, () => {
			const claim = this.#owner(channel);
			if (!claim) throw new Error(`no conversation owns ${channel}`);
			return claim.startFresh(channel);
		});
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

	stop(channel: ChannelKey): boolean {
		return this.#options.stop(channel);
	}

	postsInPlace(channel: ChannelKey): boolean {
		return this.#owner(channel)?.postsInPlace === true;
	}
}
