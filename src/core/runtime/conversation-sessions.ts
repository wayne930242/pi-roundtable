import { mkdirSync } from "node:fs";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { ownerAttachmentDir } from "../attachments/attachment-dir.ts";
import type {
	ChannelKey,
	PendingConfirmation,
} from "../domain/conversation.ts";
import type { TurnConversation, TurnRequest } from "../domain/ports.ts";
import type { ThinkingLevel } from "../models.ts";
import type { ToolTiers } from "../tool-tiers.ts";
import { ConfirmationGate, unexpired } from "./extensions/confirmation-gate.ts";
import { PromptSlot } from "./prompt-slot.ts";
import type { ChannelSession, PiAgentRuntimeOptions } from "./runtime-types.ts";
import { revisionsKey, skillsKey } from "./runtime-types.ts";
import {
	conversationChanged,
	namedConversation,
	sessionConversation,
} from "./session-conversation.ts";
import type { SessionFactory } from "./session-factory.ts";
import {
	historyMessages,
	historyScope,
	scopedHistory,
} from "./session-scope.ts";

type AgentMessage = AgentSession["messages"][number];

/** The open sessions of a runtime's conversations and what is held for each of them. */
export class ConversationSessions {
	readonly #options: PiAgentRuntimeOptions;
	readonly #factory: SessionFactory;
	readonly #tiers: ToolTiers;
	readonly #sessions = new Map<ChannelKey, Promise<ChannelSession>>();
	readonly #gates = new Map<ChannelKey, ConfirmationGate>();
	/**
	 * What the store held for a conversation that has no gate yet, once read: a host asks what is
	 * pending before the conversation's first turn after a restart, which builds its gate.
	 */
	readonly #restored = new Map<ChannelKey, PendingConfirmation | undefined>();
	/** Each conversation's way to ask the owner during its current turn. */
	readonly #slots = new Map<ChannelKey, PromptSlot>();
	/** Each conversation's level the judge picked for its last turn, kept while the judge is unsure. */
	readonly judged = new Map<ChannelKey, ThinkingLevel>();
	/** Each conversation's context use after its latest turn, for the agent dashboard. */
	readonly usage = new Map<
		ChannelKey,
		{ tokens: number | null; contextWindow: number }
	>();

	constructor(
		options: PiAgentRuntimeOptions,
		factory: SessionFactory,
		tiers: ToolTiers,
	) {
		this.#options = options;
		this.#factory = factory;
		this.#tiers = tiers;
	}

	/** The held actions of a conversation whose gate is open, or that `held` has restored from the store. */
	pending(channel: ChannelKey): PendingConfirmation | undefined {
		const gate = this.#gates.get(channel);
		return gate ? gate.pending() : unexpired(this.#restored.get(channel));
	}

	/**
	 * The conversation's held actions, restored from the store the first time they are asked for
	 * after a restart. Builds neither a gate nor a session: a gate's flavour follows the turn that
	 * first needs it, an agent's or not, and only the turn knows which.
	 */
	async held(key: ChannelKey): Promise<PendingConfirmation | undefined> {
		if (!this.#gates.has(key) && !this.#restored.has(key)) {
			const stored = await this.#options.confirmations.load(key);
			// A turn may have built the gate while the store was read; its held actions are the later ones.
			if (!this.#gates.has(key)) this.#restored.set(key, stored);
		}
		return this.pending(key);
	}

	/** Disposes every open session. */
	dispose(): void {
		for (const pending of this.#sessions.values()) {
			void pending
				.then(({ session }) => session.dispose())
				.catch(() => undefined);
		}
		this.#sessions.clear();
	}

	/**
	 * One gate per conversation, restored from the store the first time it is used. An agent's
	 * gate also judges its shell and file tools against the shared workspace.
	 */
	async gate(key: ChannelKey, agent: boolean): Promise<ConfirmationGate> {
		let gate = this.#gates.get(key);
		if (!gate) {
			const agents = agent ? this.#options.agents : undefined;
			gate = new ConfirmationGate(
				this.#factory.link().holds,
				this.#options.owner,
				await this.#options.confirmations.load(key),
				agents
					? {
							workspace: agents.workDir,
							...(agents.scratchDir ? { scratchDir: agents.scratchDir } : {}),
						}
					: {},
				this.#tiers,
			);
			this.#gates.set(key, gate);
			this.#restored.delete(key);
		}
		return gate;
	}

	slot(key: ChannelKey): PromptSlot {
		let slot = this.#slots.get(key);
		if (!slot) {
			slot = new PromptSlot();
			this.#slots.set(key, slot);
		}
		return slot;
	}

	/**
	 * The conversation's session, created on first use. `request` says what a new one is for:
	 * an agent session gets the agent tools; absent, an owner channel's session is opened.
	 */
	session(
		key: ChannelKey,
		request?: Pick<TurnRequest, "channel" | "agent" | "kind" | "conversation">,
	): Promise<ChannelSession> {
		let pending = this.#sessions.get(key);
		if (!pending) {
			const sessionDir = this.#factory.sessionDir(key);
			mkdirSync(sessionDir, { recursive: true });
			const channel = request?.channel ?? key;
			const agent = request?.agent;
			pending = (async () => {
				const conversation = await sessionConversation(
					key,
					request,
					this.#options,
				);
				// A history of another scope is archived, never replayed, and what it held goes with it,
				// after a restart too: no one approves, or reads, an action held for someone else.
				const { history, archived } = scopedHistory(
					sessionDir,
					this.#factory.cwd(agent),
					conversation,
				);
				if (archived > 0) {
					this.#options.logger.info(
						{ channel: key, archived },
						"the conversation serves someone else now; its earlier history was archived",
					);
					this.#gates.delete(key);
					this.#restored.delete(key);
					await this.#options.confirmations.save(key, undefined);
				}
				return this.#factory.create(
					agent?.home ?? channel,
					history,
					await this.gate(key, agent !== undefined),
					this.slot(key),
					ownerAttachmentDir(this.#options.dataDir, channel),
					agent,
					request?.kind ?? "owner",
					conversation,
				);
			})();
			pending.catch(() => this.#sessions.delete(key));
			this.#sessions.set(key, pending);
		}
		return pending;
	}

	/**
	 * Whom the conversation serves at this turn: as the turn names it, else as the host records it
	 * now, read at every turn so a record changed while the session is open counts; else as its open
	 * session was made for, or its history records, so a conversation nothing names carries on as it
	 * was, after a restart too; else shared.
	 */
	async conversation(
		key: ChannelKey,
		request: Pick<TurnRequest, "agent" | "conversation">,
	): Promise<TurnConversation> {
		const named = await namedConversation(key, request, this.#options);
		if (named) return named;
		const open = this.#sessions.get(key);
		if (open) return (await open).conversation;
		return (
			historyScope(
				this.#factory.sessionDir(key),
				this.#factory.cwd(request.agent),
			) ?? { visibility: "shared" }
		);
	}

	/**
	 * The conversation's session for the turn: rebuilt with its history when its session tools or
	 * skills changed, and made anew, with nothing held for it, when the conversation serves someone
	 * else than it was made for, its history archived rather than replayed.
	 */
	async freshSession(
		key: ChannelKey,
		request: TurnRequest,
	): Promise<ChannelSession> {
		const channelSession = await this.session(key, request);
		if (
			conversationChanged(channelSession.conversation, request.conversation)
		) {
			this.#options.logger.info(
				{ channel: key },
				"the conversation's scope changed; starting an isolated session",
			);
			await this.forget(key);
			return this.session(key, request);
		}
		const stale = this.#staleReason(channelSession, request);
		if (!stale) return channelSession;
		this.#options.logger.info(
			{ channel: key },
			`${stale}; rebuilding the session`,
		);
		channelSession.session.dispose();
		this.#sessions.delete(key);
		return this.session(key, request);
	}

	/** Why a cached session must be rebuilt, keeping its history, before this turn; undefined when it is current. */
	#staleReason(
		channelSession: ChannelSession,
		request: TurnRequest,
	): string | undefined {
		if (channelSession.revisions !== revisionsKey(this.#factory.plan))
			return "session tools changed";
		if (
			channelSession.skills !== skillsKey(this.#factory.skillsOf(request.agent))
		)
			return "skills changed";
		return undefined;
	}

	/**
	 * The messages of a conversation's history: its open session's, or else read from its files
	 * without opening one, so reading them fixes no scope; none when they were recorded, or its open
	 * session was made, for someone else than the conversation serves now.
	 */
	async messages(key: ChannelKey): Promise<readonly AgentMessage[]> {
		const now = await this.conversation(key, {});
		const open = this.#sessions.get(key);
		if (open) {
			const { conversation, session } = await open;
			return conversationChanged(conversation, now) ? [] : session.messages;
		}
		return historyMessages(
			this.#factory.sessionDir(key),
			this.#factory.cwd(undefined),
			now,
		);
	}

	/** Drops the open session and everything held for the conversation, leaving its files. */
	// pi-lens-ignore: mixed-async-styles — disposal failures of a dropped session are swallowed in a chain on purpose
	async forget(channel: ChannelKey): Promise<void> {
		const pending = this.#sessions.get(channel);
		this.#sessions.delete(channel);
		await pending
			?.then(({ session }) => session.dispose())
			.catch(() => undefined);
		this.#gates.delete(channel);
		this.#restored.delete(channel);
		this.#slots.delete(channel);
		this.usage.delete(channel);
		this.judged.delete(channel);
		await this.#options.confirmations.save(channel, undefined);
	}
}
