import type { ChannelKey } from "../domain/conversation.ts";
import { AgentError, IdentityError } from "../domain/errors.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import { HostStoppingError } from "../errors.ts";
import { messages } from "../i18n/index.ts";
import { SYSTEM_PRINCIPAL } from "../identity/principal-store.ts";
import { isQuiet } from "../presentation/reply-body.ts";
import { splitReply } from "../presentation/reply-splitter.ts";
import { addressee, type Speaker } from "../speakers.ts";
import type { OutboxEntry, StoredOutboxEntry } from "./agent-outbox.ts";
import {
	agentFailureText,
	agentMessageText,
	agentReplyText,
	chainLimitReason,
	deliveredMessagePost,
	returnedAnswerPost,
} from "./agent-prompt.ts";
import type { Agent } from "./agent-store.ts";
import { conversationLabel, messageTarget } from "./message-target.ts";
import { discordIdOf, discordKey, scopeOf } from "./team-keys.ts";
import {
	type Chain,
	type Exchange,
	MAX_CHAIN_MESSAGES,
	type TurnHost,
} from "./team-turn-types.ts";

/** Messages between agents: each runs the target's turn, then wakes the sender with the answer. */
export class AgentMessages {
	readonly #host: TurnHost;
	/** The writes of entries the host refused while it stopped, which the shutdown waits for. */
	readonly #keeping = new Set<Promise<void>>();
	/** The last write, which the next waits for: ids follow the order the queue refused the entries in. */
	#lastKept: Promise<void> = Promise.resolve();

	constructor(host: TurnHost) {
		this.#host = host;
	}

	/** What is still being written to the outbox; the shutdown drain waits until it is empty. */
	busy(): string[] {
		return this.#keeping.size > 0 ? ["agent messages being kept"] : [];
	}

	message(
		caller: AgentTurnScope,
		to: string,
		text: string,
		conversation?: string,
	): string {
		const { store, queue, logger, surfaces } = this.#host.options;
		if (to === caller.name)
			throw new AgentError("message_agent is for other agents, not yourself.");
		const target = store.activeAgent(to);
		const sender = store.activeAgent(caller.name);
		// The sender writes from its turn channel, to which the answer returns.
		const parent = this.#host.turnChannel(caller);
		const targetChannel = messageTarget(
			{
				store,
				roomSurfaces: surfaces?.roomSurfaces() ?? [],
				latest: store.conversations.latest(target.name),
				from: parent,
				routes: this.#host.routes,
			},
			target,
			conversation,
		);
		// Every agent turn runs through #turn, which registers its chain; a message from anywhere
		// else would start an uncounted chain, so it is refused.
		const chain = this.#host.chains.get(caller.session);
		if (!chain)
			throw new AgentError(
				"message_agent can only be used during an agent turn.",
			);
		if (chain.messages >= MAX_CHAIN_MESSAGES)
			throw new AgentError(
				chainLimitReason(addressee(chain.speaker, this.#host.options.owner)),
			);
		// A temp knight talks only to the conversation it was made from (and to the owners), so one
		// person's helper session is not open to another person's turn.
		if (target.parent !== undefined && chain.speaker.tier !== "owner") {
			const own = sender.name === target.parent && target.origin === parent;
			if (!own)
				throw new AgentError(
					`"${target.name}" is a temp knight of "${target.parent}" and answers only the conversation that made it; ask "${target.parent}" there.`,
				);
		}
		chain.messages += 1;
		// A temp knight is working from the moment a message is handed to it until it has answered.
		this.#host.helpers.begin(target.name);
		// The thread opens in the sender's turn channel, on its surface when that hosts threads; a
		// surface that hosts none leaves the answer returning to the sender's conversation.
		const exchange = this.#openExchange(parent, sender, target, text);
		void queue
			.run(targetChannel, async () =>
				this.#deliver(
					sender,
					target,
					text,
					chain,
					await exchange,
					targetChannel,
					parent,
				),
			)
			.catch((error: unknown) => {
				if (error instanceof HostStoppingError) {
					// Refused before it started: the thread it opened has nothing more to hold.
					void exchange.then((opened) => opened?.thread.close());
					this.#keep({
						kind: "message",
						sender: sender.name,
						target: target.name,
						channel: targetChannel,
						text,
						origin: parent,
						speaker: chain.speaker,
						messages: chain.messages,
					});
					return;
				}
				logger.error(
					{ from: sender.name, to: target.name, err: error },
					"agent message not delivered",
				);
			})
			.finally(() => this.#host.helpers.end(target.name));
		logger.info(
			{
				from: sender.name,
				to: target.name,
				channel: targetChannel,
				chain: chain.messages,
			},
			"agent message queued",
		);
		return `Sent to "${target.displayName}" in its ${conversationLabel(targetChannel)}. It works there; its answer comes back to you as a new turn.`;
	}

	/**
	 * Opens the message's thread in the sender's turn channel, a Discord channel or a room, and
	 * posts the request there under the sender's name; undefined where no thread opens. Never
	 * rejects.
	 */
	async #openExchange(
		parent: ChannelKey,
		sender: Agent,
		target: Agent,
		text: string,
	): Promise<Exchange | undefined> {
		const thread = await this.#host.options.threads?.open(
			parent,
			`→ ${target.displayName}`,
		);
		if (!thread) return undefined;
		await this.#host
			.post(parent, this.#host.current(sender), {
				chunks: splitReply(
					deliveredMessagePost(this.#host.current(target), text),
				),
				threadId: thread.id,
			})
			.catch((error: unknown) =>
				this.#host.options.logger.warn(
					{ err: error },
					"agent request not threaded",
				),
			);
		return { parent, thread };
	}

	/** Runs the target's turn, then posts its answer and wakes the sender; closes the thread either way. */
	async #deliver(
		sender: Agent,
		target: Agent,
		text: string,
		chain: Chain,
		exchange: Exchange | undefined,
		targetChannel: ChannelKey,
		senderChannel: ChannelKey,
	): Promise<void> {
		try {
			await this.#exchange(
				sender,
				target,
				text,
				chain,
				exchange,
				targetChannel,
				senderChannel,
			);
		} finally {
			await exchange?.thread.close();
		}
	}

	async #exchange(
		sender: Agent,
		target: Agent,
		text: string,
		chain: Chain,
		exchange: Exchange | undefined,
		targetChannel: ChannelKey,
		senderChannel: ChannelKey,
	): Promise<void> {
		const { queue, logger } = this.#host.options;
		await this.#host.post(targetChannel, this.#host.current(sender), {
			chunks: splitReply(
				deliveredMessagePost(this.#host.current(target), text),
			),
		});
		const result = await this.#host.turn(
			target,
			scopeOf(target, targetChannel),
			targetChannel,
			agentMessageText(
				this.#host.current(sender),
				text,
				addressee(chain.speaker, this.#host.options.owner),
			),
			chain,
			{ unattended: true },
		);
		const thread = exchange?.thread;
		if (thread && !result.ok)
			await thread.close(messages().agentNoReply(result.error.message));
		// A target with nothing to answer sends nothing back and wakes nobody.
		if (isQuiet(result)) {
			logger.info(
				{ from: sender.name, to: target.name },
				"agent message answered with nothing; no follow-up",
			);
			return;
		}
		const current = this.#host.options.store.agent(sender.name);
		if (current?.status !== "active") return;
		// With a thread the answer goes there, leaving the sender's channel its own reply.
		if (result.ok)
			await this.#host
				.post(senderChannel, this.#host.current(target), {
					chunks: splitReply(returnedAnswerPost(result.text)),
					...(thread ? { threadId: thread.id } : {}),
				})
				.catch((error: unknown) =>
					logger.error({ err: error }, "agent answer not posted back"),
				);
		await thread?.close();
		const followUp = result.ok
			? agentReplyText(
					addressee(chain.speaker, this.#host.options.owner),
					this.#host.current(target),
					result.text,
					thread?.mention,
				)
			: agentFailureText(
					addressee(chain.speaker, this.#host.options.owner),
					this.#host.current(target),
					result.error.message,
					thread?.mention,
				);
		// The answer is a report back to the sender, so its turn may ask the owner on cards.
		void queue
			.run(senderChannel, () =>
				this.#followUp(current, senderChannel, followUp, chain),
			)
			.catch((error: unknown) => {
				if (error instanceof HostStoppingError) {
					// The sender would wait for this answer forever, so it waits in the outbox for the next start.
					this.#keep({
						kind: "reply",
						sender: current.name,
						target: target.name,
						channel: senderChannel,
						text: followUp,
						speaker: chain.speaker,
						messages: chain.messages,
					});
					return;
				}
				logger.error({ err: error }, "agent follow-up failed");
			});
	}

	/** The sender's turn that carries the target's answer; it may ask the owner on cards, as a report back does. */
	#followUp(sender: Agent, channel: ChannelKey, text: string, chain: Chain) {
		return this.#host.turn(
			sender,
			scopeOf(sender, channel),
			channel,
			text,
			chain,
			{ interactive: true },
		);
	}

	/** Writes an entry the queue refused to the outbox; the write is waited for by the shutdown. */
	#keep(entry: OutboxEntry): void {
		const { store, logger } = this.#host.options;
		const write = this.#lastKept
			.then(() => store.outbox.keep(entry))
			.then(
				() =>
					logger.info(
						{ kind: entry.kind, from: entry.sender, to: entry.target },
						"agent message kept for the next start",
					),
				(error: unknown) =>
					logger.error(
						{
							kind: entry.kind,
							from: entry.sender,
							to: entry.target,
							err: error,
						},
						"agent message lost: not kept for the next start",
					),
			);
		this.#lastKept = write;
		this.#keeping.add(write);
		void write.finally(() => this.#keeping.delete(write));
	}

	/**
	 * Delivers what the last run kept, oldest first, each through the queue of the conversation it
	 * addressed; never rejects. An entry is taken out of the outbox when its turn starts, so it runs
	 * once even with a second replay or another host reading the same table; one the queue refuses
	 * stays for the next start.
	 */
	async replay(): Promise<void> {
		const { store, queue, logger } = this.#host.options;
		// A failed read leaves the entries kept for the next start and does not fail this one.
		const entries = await store.outbox.pending().catch((error: unknown) => {
			logger.error({ err: error }, "kept agent messages not read");
			return [];
		});
		if (entries.length === 0) return;
		logger.info({ count: entries.length }, "replaying agent messages");
		for (const entry of entries)
			void queue
				.run(entry.channel, () => this.#replayOne(entry))
				.catch((error: unknown) => {
					if (error instanceof HostStoppingError)
						logger.info(
							{ id: entry.id },
							"agent message stays kept: the host is stopping",
						);
					else
						logger.error(
							{ id: entry.id, err: error },
							"agent message not replayed",
						);
				});
	}

	/** The kept speaker as they stand now, like a background turn's author; undefined when gone or disabled. */
	async #stillRunsAs(kept: Speaker): Promise<Speaker | undefined> {
		const principals = this.#host.options.principals?.();
		if (!principals || kept.principalId === SYSTEM_PRINCIPAL) return kept;
		try {
			const now = await principals.speakerFor(kept.principalId, kept.tier);
			return { ...kept, tier: now.tier, principalId: now.principalId };
		} catch (error) {
			if (error instanceof IdentityError) return undefined;
			throw error;
		}
	}

	async #replayOne(entry: StoredOutboxEntry): Promise<void> {
		const { store, logger } = this.#host.options;
		if (!(await store.outbox.claim(entry.id))) return;
		const sender = store.agent(entry.sender);
		const target = store.agent(entry.target);
		// An agent archived or moved to another channel since has no turn to give the entry.
		const has = (agent: Agent | undefined, channel: ChannelKey) =>
			agent?.status === "active" &&
			(discordIdOf(channel) === undefined ||
				(agent.channelId !== undefined &&
					discordKey(agent.channelId) === channel));
		const origin = entry.origin ?? entry.channel;
		const intact =
			entry.kind === "message"
				? has(target, entry.channel) && has(sender, origin)
				: has(sender, entry.channel);
		if (!sender || !target || !intact) {
			logger.warn(
				{ id: entry.id, from: entry.sender, to: entry.target },
				"kept agent message dropped: its agent or channel is gone",
			);
			return;
		}
		logger.info(
			{ id: entry.id, kind: entry.kind, from: entry.sender, to: entry.target },
			"replaying a kept agent message",
		);
		const speaker = await this.#stillRunsAs(entry.speaker);
		if (!speaker) {
			logger.warn(
				{ id: entry.id, from: entry.sender },
				"kept agent message dropped: its speaker may no longer run",
			);
			return;
		}
		const chain: Chain = { messages: entry.messages, speaker };
		if (entry.kind === "reply") {
			await this.#followUp(sender, entry.channel, entry.text, chain);
			return;
		}
		// Its thread was closed when the host refused it, so the answer returns to the sender's conversation.
		this.#host.helpers.begin(target.name);
		try {
			await this.#exchange(
				sender,
				target,
				entry.text,
				chain,
				undefined,
				entry.channel,
				origin,
			);
		} finally {
			this.#host.helpers.end(target.name);
		}
	}
}
