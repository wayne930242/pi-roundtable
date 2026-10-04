import { mkdirSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ownerAttachmentDir } from "../attachments/attachment-dir.ts";
import type {
	ChannelKey,
	PendingConfirmation,
} from "../domain/conversation.ts";
import type { TurnRequest } from "../domain/ports.ts";
import type { ThinkingLevel } from "../models.ts";
import type { ToolTiers } from "../tool-tiers.ts";
import { ConfirmationGate } from "./extensions/confirmation-gate.ts";
import { PromptSlot } from "./prompt-slot.ts";
import type { ChannelSession, PiAgentRuntimeOptions } from "./runtime-types.ts";
import { revisionsKey, skillsKey } from "./runtime-types.ts";
import type { SessionFactory } from "./session-factory.ts";

/** The open sessions of a runtime's conversations and what is held for each of them. */
export class ConversationSessions {
	readonly #options: PiAgentRuntimeOptions;
	readonly #factory: SessionFactory;
	readonly #tiers: ToolTiers;
	readonly #sessions = new Map<ChannelKey, Promise<ChannelSession>>();
	readonly #gates = new Map<ChannelKey, ConfirmationGate>();
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

	/** The held actions of a conversation whose gate is open. */
	pending(channel: ChannelKey): PendingConfirmation | undefined {
		return this.#gates.get(channel)?.pending();
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
		request?: Pick<TurnRequest, "channel" | "agent" | "kind">,
	): Promise<ChannelSession> {
		let pending = this.#sessions.get(key);
		if (!pending) {
			const sessionDir = this.#factory.sessionDir(key);
			mkdirSync(sessionDir, { recursive: true });
			const channel = request?.channel ?? key;
			const agent = request?.agent;
			pending = (async () =>
				this.#factory.create(
					agent?.home ?? channel,
					SessionManager.continueRecent(this.#factory.cwd(agent), sessionDir),
					await this.gate(key, agent !== undefined),
					this.slot(key),
					ownerAttachmentDir(this.#options.dataDir, channel),
					agent,
					request?.kind ?? "owner",
				))();
			pending.catch(() => this.#sessions.delete(key));
			this.#sessions.set(key, pending);
		}
		return pending;
	}

	/** The conversation's session, rebuilt with its history when its session tools or skills changed. */
	async freshSession(
		key: ChannelKey,
		request: TurnRequest,
	): Promise<ChannelSession> {
		const channelSession = await this.session(key, request);
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

	/** Why a cached session must be rebuilt before this turn, or undefined when it is current. */
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

	/** Drops the open session and everything held for the conversation, leaving its files. */
	// pi-lens-ignore: mixed-async-styles — disposal failures of a dropped session are swallowed in a chain on purpose
	async forget(channel: ChannelKey): Promise<void> {
		const pending = this.#sessions.get(channel);
		this.#sessions.delete(channel);
		await pending
			?.then(({ session }) => session.dispose())
			.catch(() => undefined);
		this.#gates.delete(channel);
		this.#slots.delete(channel);
		this.usage.delete(channel);
		this.judged.delete(channel);
		await this.#options.confirmations.save(channel, undefined);
	}
}
