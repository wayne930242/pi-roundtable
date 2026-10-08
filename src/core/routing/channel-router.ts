import {
	type Admission,
	type BackgroundTarget,
	type BackgroundTurn,
	type ChannelClaim,
	type ConversationPort,
	type InboundMessage,
	QUEUED_MARK,
	type ScheduledOutcome,
	STEERED_MARK,
} from "../contract/channels.ts";
import { parseChannelKey } from "../contract/surface.ts";
import { PluginError } from "../errors.ts";
import type { ActorFacts } from "../identity/actor-facts.ts";
import type { Contact, ContactAssessor } from "../identity/contact.ts";
import type { Logger } from "../log.ts";
import type { ChannelKey } from "../sessions.ts";
import type { ChannelQueue } from "./channel-queue.ts";
import { ForwardJoin } from "./forward-join.ts";

export interface ChannelRouterOptions {
	/** Claims in registration order; the router orders them by priority. */
	claims: readonly ChannelClaim[];
	queue: ChannelQueue;
	/** The contributed background target of a name, read at use time. */
	targets(name: string): BackgroundTarget | undefined;
	logger: Logger;
	/** Who the authors of messages are; without it, no message carries a speaker. */
	contacts?: ContactAssessor;
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
	/** Each channel's messages being admitted, so they reach their claim and the queue in the order they came. */
	readonly #admitting = new Map<ChannelKey, Promise<unknown>>();
	/** The surfaces already warned that their messages carry no actor. */
	readonly #warned = new Set<string>();

	constructor(options: ChannelRouterOptions) {
		this.#options = options;
		this.#claims = orderClaims(options.claims);
		this.#forwards = new ForwardJoin(options.forwardJoinMs);
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

	async #route(message: InboundMessage): Promise<void> {
		if (
			!message.text.trim() &&
			message.attachments.length === 0 &&
			!message.forwarded?.text.trim()
		)
			return;
		const claim = this.#owner(message.channel, message.space);
		if (!claim) return;
		const started = await this.#inOrder(message.channel, async () => {
			const admission = await this.#admit(claim, message);
			return admission && (await this.#start(message, admission));
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
	 * The claim's admission of the message, which carries the speaker its author resolves to; one
	 * who cannot be resolved, such as while the database is down, reaches the claim as no one. The
	 * author's contact is recorded, such as their first contact linked, only once the claim takes
	 * the message, so a message nobody serves links or makes no one. A linked author the rules
	 * refuse is still recorded as seen at no tier as the message is assessed, whether or not a
	 * claim then takes it, at most once in a while. The admission stands even when that
	 * record fails or finds them linked elsewhere meanwhile: the claim decided on who they were a
	 * moment before, as a change another process makes is seen within the identity service's cache
	 * anyway, and it may hold state for what it admitted.
	 */
	async #admit(
		claim: ChannelClaim,
		message: InboundMessage,
	): Promise<Admission | undefined> {
		const { logger, contacts } = this.#options;
		const { speaker: _given, ...facts } = message;
		const actor = this.#actorOf(message);
		let contact: Contact | undefined;
		if (actor && contacts)
			try {
				contact = await contacts.assess(actor, {
					conversation: message.channel,
				});
			} catch (error) {
				logger.error(
					{ channel: message.channel, err: error },
					"could not resolve who wrote a message; it reaches its claim as no one",
				);
			}
		const admission = claim.admit(
			contact
				? { ...facts, speaker: Object.freeze({ ...contact.speaker }) }
				: facts,
		);
		if (!admission || !contact) return admission;
		try {
			const taken = await contact.take();
			if (taken?.principalId !== contact.speaker.principalId)
				logger.warn(
					{ channel: message.channel },
					"the author of a message was linked elsewhere, or refused, while it was admitted; it runs as who they were",
				);
		} catch (error) {
			logger.error(
				{ channel: message.channel, err: error },
				"could not record who wrote a message; it runs as who they were",
			);
		}
		return admission;
	}

	/**
	 * Who wrote the message, as its surface reports them; a surface that reports no `actor` has it
	 * read from the author fields under its own name, once warned. None for a bot or an
	 * integration.
	 */
	#actorOf(message: InboundMessage): ActorFacts | undefined {
		if (message.authorIsBot || message.integration) return undefined;
		if (message.actor) return message.actor;
		const { surface } = parseChannelKey(message.channel);
		if (!this.#warned.has(surface)) {
			this.#warned.add(surface);
			this.#options.logger.warn(
				{ surface },
				`deprecated: the ${surface} surface reports no InboundMessage.actor, so its authors are read from authorId, authorName, and authorRoleIds as ${surface} identities; set actor, as this goes away in 1.0`,
			);
		}
		return {
			provider: surface,
			subject: message.authorId,
			name: message.authorName,
			surface,
			...(message.authorRoleIds
				? {
						roles: message.authorRoleIds.map(
							(role) => `${surface}:role:${role}`,
						),
					}
				: {}),
			...(message.space ? { space: message.space } : {}),
			legacyId: message.authorId,
		};
	}

	/**
	 * Starts what the claim admitted, in the channel's queue, and returns while it runs: a message
	 * during a turn is first offered to it, then marked as waiting.
	 */
	async #start(
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
		let queued = false;
		// A message during a turn is added to it when the turn takes it, otherwise marked as waiting.
		if (busy && queue.size(message.channel) > 0) {
			if (await busy.steer?.()) return { done: busy.react(STEERED_MARK) };
			await busy.react(QUEUED_MARK);
			queued = true;
		}
		const done = queue
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
		return { done };
	}

	target(name: string): BackgroundTarget | undefined {
		return this.#options.targets(name);
	}

	/**
	 * A turn nobody wrote, run by the channel's claim inside its queue; never rejects. A turn whose
	 * target no plugin contributes is skipped, never handed to another target's claim.
	 */
	async background(turn: BackgroundTurn): Promise<ScheduledOutcome> {
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

	/** Asks only the claim that owns the channel; false when none does or it has no `stop`. */
	stop(channel: ChannelKey): boolean {
		return this.#owner(channel)?.stop?.(channel) ?? false;
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
}
