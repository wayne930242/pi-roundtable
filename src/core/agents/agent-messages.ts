import { AgentError } from "../domain/errors.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import { messages } from "../i18n/index.ts";
import { splitReply } from "../presentation/reply-splitter.ts";
import { addressee } from "../speakers.ts";
import {
	agentFailureText,
	agentMessageText,
	agentReplyText,
	chainLimitReason,
	deliveredMessagePost,
	returnedAnswerPost,
} from "./agent-prompt.ts";
import type { Agent } from "./agent-store.ts";
import { discordKey, homeScope } from "./team-keys.ts";
import {
	type Chain,
	type Exchange,
	MAX_CHAIN_MESSAGES,
	type TurnHost,
} from "./team-turn-types.ts";

/** Messages between agents: each runs the target's turn, then wakes the sender with the answer. */
export class AgentMessages {
	readonly #host: TurnHost;

	constructor(host: TurnHost) {
		this.#host = host;
	}

	message(caller: AgentTurnScope, to: string, text: string): string {
		const { store, queue, logger } = this.#host.options;
		if (to === caller.name)
			throw new AgentError("message_agent is for other agents, not yourself.");
		const target = store.activeAgent(to);
		const sender = store.activeAgent(caller.name);
		if (!target.channelId) throw new AgentError(`${to} has no channel yet.`);
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
		chain.messages += 1;
		const targetChannel = discordKey(target.channelId);
		const exchange = this.#openExchange(caller, sender, target, text);
		void queue
			.run(targetChannel, async () =>
				this.#deliver(sender, target, text, chain, await exchange),
			)
			.catch((error: unknown) =>
				logger.error(
					{ from: sender.name, to: target.name, err: error },
					"agent message not delivered",
				),
			);
		logger.info(
			{ from: sender.name, to: target.name, chain: chain.messages },
			"agent message queued",
		);
		return `Sent to "${target.displayName}". It works in its own channel; its answer comes back to you as a new turn.`;
	}

	/**
	 * Opens the message's thread in the sender's turn channel and posts the request there under
	 * the sender's name; undefined where no thread opens. Never rejects.
	 */
	async #openExchange(
		caller: AgentTurnScope,
		sender: Agent,
		target: Agent,
		text: string,
	): Promise<Exchange | undefined> {
		const parent = this.#host.turnChannel(caller);
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
	): Promise<void> {
		try {
			await this.#exchange(sender, target, text, chain, exchange);
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
	): Promise<void> {
		const { queue, logger } = this.#host.options;
		const targetChannel = discordKey(target.channelId ?? "");
		await this.#host.post(targetChannel, this.#host.current(sender), {
			chunks: splitReply(
				deliveredMessagePost(this.#host.current(target), text),
			),
		});
		const result = await this.#host.turn(
			target,
			homeScope(target),
			targetChannel,
			agentMessageText(
				this.#host.current(sender),
				text,
				addressee(chain.speaker, this.#host.options.owner),
			),
			chain,
		);
		const thread = exchange?.thread;
		if (thread && !result.ok)
			await thread.close(messages().agentNoReply(result.error.message));
		const current = this.#host.options.store.agent(sender.name);
		if (current?.status !== "active" || !current.channelId) return;
		const senderChannel = discordKey(current.channelId);
		// With a thread the answer goes there, leaving the sender's channel its own reply.
		if (result.ok)
			await this.#host
				.post(exchange?.parent ?? senderChannel, this.#host.current(target), {
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
				this.#host.turn(
					current,
					homeScope(current),
					senderChannel,
					followUp,
					chain,
					{
						interactive: true,
					},
				),
			)
			.catch((error: unknown) =>
				logger.error({ err: error }, "agent follow-up failed"),
			);
	}
}
