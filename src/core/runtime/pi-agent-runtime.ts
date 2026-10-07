import { rmSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentSession,
	type ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { ownerAttachmentDir } from "../attachments/attachment-dir.ts";
import { withAttachmentsBlock } from "../attachments/prompt-block.ts";
import type { AgentRuntime } from "../contract/runtime.ts";
import { NO_ATTACHMENTS, type TurnAttachments } from "../domain/attachment.ts";
import type {
	ChannelKey,
	PendingConfirmation,
	TranscriptEntry,
	TurnResult,
} from "../domain/conversation.ts";
import { AgentRunError, ConfigError } from "../domain/errors.ts";
import type { TurnRequest } from "../domain/ports.ts";
import { assistantName } from "../i18n/index.ts";
import {
	AUTO_THINKING,
	parseModelRef,
	type ThinkingLevel,
	type ThinkingSetting,
} from "../models.ts";
import { withoutReplyFiles } from "../reply-files.ts";
import { planOrder, type TransientTask } from "../sessions.ts";
import { textOf } from "../shared/session-messages.ts";
import { addressee, type Speaker, type Tier } from "../speakers.ts";
import { type ToolTiers, toolsForTier, toolTiers } from "../tool-tiers.ts";
import { ConversationSessions } from "./conversation-sessions.ts";
import { ASK_USER_TOOL } from "./extensions/ask-user.ts";
import {
	ConfirmationGate,
	confirmedTurnText,
} from "./extensions/confirmation-gate.ts";
import { COMPACT_TOOL } from "./extensions/self-compact-guard.ts";
import { interimPoster } from "./interim-text.ts";
import { PromptSlot, workTimeout } from "./prompt-slot.ts";
import {
	type PiAgentRuntimeOptions,
	TRANSCRIPT_ENTRY_CHARS,
	type TurnMessage,
} from "./runtime-types.ts";
import { archiveSessions } from "./session-archive.ts";
import { SessionFactory } from "./session-factory.ts";
import { type PromptImages, SteerableRun } from "./steerable-run.ts";
import { lastReply, turnAnswer } from "./turn-answer.ts";
import { progressReporter } from "./turn-progress.ts";
import { workerReport } from "./worker-task.ts";

export {
	type CoreExtensions,
	type LoadedSkill,
	type PiAgentRuntimeOptions,
	sessionExtensions,
} from "./runtime-types.ts";

/** AgentRuntime over the Pi SDK: one persistent session per channel, each with its own loader. */
const STOPPED = "stopped by the owner";

// pi-lens-ignore: large-class — pi-roundtable batches 2b and 4 move tools, dispatch, and routing out of it
export class PiAgentRuntime implements AgentRuntime {
	readonly #options: PiAgentRuntimeOptions;
	readonly #modelRuntime: ModelRuntime;
	readonly #tiers: ToolTiers;
	readonly #factory: SessionFactory;
	readonly #sessions: ConversationSessions;
	/** The tier and speaker of each conversation's running turn. */
	readonly #turns = new Map<
		ChannelKey,
		{ tier: Tier; speaker: Speaker | undefined }
	>();
	/** Each conversation's turn in progress, which the owner may steer or stop. */
	readonly #running = new Map<ChannelKey, SteerableRun>();

	/** Builds the runtime without starting a session; the preflight proves it can run. */
	constructor(options: PiAgentRuntimeOptions) {
		this.#options = options;
		this.#modelRuntime = options.modelRuntime;
		this.#tiers = options.toolTiers ?? toolTiers();
		this.#factory = new SessionFactory(options, {
			speaker: (channel) => this.#turns.get(channel)?.speaker,
			runTask: (channel, task) => this.#runTask(channel, task),
		});
		this.#sessions = new ConversationSessions(
			options,
			this.#factory,
			this.#tiers,
		);
	}

	/**
	 * Proves the model and every required tool resolve, in a throwaway session that runs no turn;
	 * startup stops here before anything connects.
	 */
	async preflight(): Promise<void> {
		const probe = await this.#factory.create(
			"probe:startup",
			SessionManager.inMemory(this.#factory.workDir()),
			new ConfirmationGate(this.#factory.link().holds, this.#options.owner),
			new PromptSlot(),
			join(this.#factory.workDir(), "probe-attachments"),
			undefined,
			"owner",
		);
		const registered = new Set(
			probe.session.getAllTools().map((tool) => tool.name),
		);
		probe.session.dispose();
		const expected = [
			...this.#factory.link().requiredTools,
			COMPACT_TOOL,
			ASK_USER_TOOL,
			...planOrder(this.#factory.plan).flatMap(
				(tool) => tool.snapshot().requiredTools ?? [],
			),
		];
		const missing = expected.filter((name) => !registered.has(name));
		if (missing.length > 0) {
			throw new ConfigError(
				`required tools are not registered: ${missing.join(", ")}`,
			);
		}
	}

	// pi-lens-ignore: high-complexity, high-fan-out, mixed-async-styles — one turn's lifecycle end to end; batch 4 splits it with the channel router
	async runTurn(request: TurnRequest): Promise<TurnResult> {
		const { logger, turnTimeoutMs = 10 * 60_000 } = this.#options;
		const key = request.agent?.session ?? request.channel;
		const channelSession = await this.#sessions.freshSession(key, request);
		const { session } = channelSession;
		const level = await this.#thinkingLevel(key, session, request);
		if (session.thinkingLevel !== level) session.setThinkingLevel(level);
		const gate = await this.#sessions.gate(key, request.agent !== undefined);
		const pending = gate.pending();
		const registered = new Set(session.getAllTools().map((tool) => tool.name));
		// The speaker's tier limits the tools; a turn nobody spoke in, such as the owner's own chat, is the owner's.
		const tier = request.speaker?.tier ?? "owner";
		// An approving turn also has the held calls' tools, which a dispatched worker may have used.
		const wanted = toolsForTier(
			[
				...new Set([
					...this.#factory.toolsFor(request.selection),
					...(request.confirmed && pending
						? pending.calls.map((call) => call.tool)
						: []),
				]),
			],
			tier,
			this.#tiers,
		);
		this.#turns.set(key, { tier, speaker: request.speaker });
		const missing = wanted.filter((name) => !registered.has(name));
		if (missing.length > 0) {
			logger.warn(
				{
					channel: request.channel,
					selection: request.selection.id,
					missing,
				},
				"selected tools missing; running without them",
			);
		}
		channelSession.tools = wanted.filter((name) => registered.has(name));
		session.setActiveToolsByName([...channelSession.tools]);
		gate.beginTurn(
			request.selection.id,
			request.confirmed === true,
			addressee(request.speaker, this.#options.owner),
		);
		if (request.confirmed && pending) {
			logger.info(
				{
					channel: request.channel,
					tools: pending.calls.map((call) => call.tool),
				},
				"confirmed actions released",
			);
		}

		// Collected as they end: a compaction during the turn shortens session.messages.
		const turnMessages: TurnMessage[] = [];
		const toolCalls: string[] = [];
		// Text written before the final answer is posted as the turn goes; the final reply stays the caller's.
		const interim = interimPoster(request, this.#options);
		// The caller's live view: the text as it streams and each tool, never the thinking.
		const progress = request.progress
			? progressReporter(request.progress)
			: undefined;
		const unsubscribe = session.subscribe((event) => {
			progress?.observe(event);
			if (event.type === "tool_execution_start") {
				toolCalls.push(event.toolName);
				interim?.toolStart(event.toolName);
			}
			if (event.type === "message_end") {
				turnMessages.push(event.message);
				interim?.messageEnd(event.message);
			}
		});
		const slot = this.#sessions.slot(key);
		slot.bind(
			request.interactive
				? this.#options.prompts?.(request.channel, request.speaker)
				: undefined,
			request.agent?.name ?? assistantName(),
			interim ? () => interim.flush() : undefined,
		);
		// Time spent waiting on the owner's cards does not count towards the timeout.
		const cancelTimeout = workTimeout(turnTimeoutMs, slot, () => {
			logger.warn(
				{ channel: request.channel, turnTimeoutMs },
				"turn timed out; aborting",
			);
			void session.abort();
		});
		const running = new SteerableRun(
			session,
			() => request.steerable === true && !gate.pending(),
		);
		this.#running.set(key, running);

		try {
			const attachments = request.attachments ?? NO_ATTACHMENTS;
			const text =
				request.confirmed && pending
					? confirmedTurnText(
							pending,
							request.text,
							addressee(request.speaker, this.#options.owner),
						)
					: request.text;
			await running.run(() =>
				session.prompt(
					withAttachmentsBlock(text, attachments),
					attachments.images.length > 0
						? { images: promptImages(attachments) }
						: undefined,
				),
			);
		} catch (error) {
			if (running.stopped)
				return { ok: false, error: new AgentRunError(STOPPED), stopped: true };
			return {
				ok: false,
				error: new AgentRunError(`prompt failed: ${String(error)}`),
			};
		} finally {
			this.#running.delete(key);
			this.#turns.delete(key);
			cancelTimeout();
			slot.unbind();
			unsubscribe();
			progress?.close();
			await interim?.flush();
			gate.endTurn();
			const usage = session.getContextUsage();
			if (usage)
				this.#sessions.usage.set(key, {
					tokens: usage.tokens,
					contextWindow: usage.contextWindow,
				});
			const held = gate.pending();
			await this.#options.confirmations
				.save(key, held)
				// pi-lens-ignore: no-unknown-parameters — a rejection reason is unknown; it only reaches the logger
				.catch((error: unknown) =>
					logger.error({ channel: key, err: error }, "held actions not saved"),
				);
			if (held)
				logger.info(
					{ channel: key, held: held.calls.map((call) => call.action) },
					"actions held for confirmation",
				);
			logger.info(
				{
					channel: key,
					selection: request.selection.id,
					toolCalls,
					thinking: session.thinkingLevel,
					// pi-lens-ignore: no-conditional-empty-object-spread — owner turns keep their log line without a model key
					...(request.agent
						? { model: `${session.model?.provider}/${session.model?.id}` }
						: {}),
				},
				"turn finished",
			);
		}

		if (running.stopped)
			return { ok: false, error: new AgentRunError(STOPPED), stopped: true };
		return turnAnswer(turnMessages, running.steered);
	}

	async steer(
		channel: ChannelKey,
		text: string,
		attachments: TurnAttachments,
		speakerId?: string,
	): Promise<boolean> {
		const running = this.#running.get(channel);
		if (!running) return false;
		// A message from another speaker waits for its own turn instead of joining this one.
		const started = this.#turns.get(channel)?.speaker?.id;
		if (
			speakerId !== undefined &&
			started !== undefined &&
			speakerId !== started
		)
			return false;
		try {
			const steered = await running.steer(
				withAttachmentsBlock(text, attachments),
				promptImages(attachments),
			);
			if (steered)
				this.#options.logger.info({ channel }, "message steered into the turn");
			return steered;
		} catch (error) {
			this.#options.logger.warn({ channel, err: error }, "steer refused");
			return false;
		}
	}

	stop(channel: ChannelKey): boolean {
		const stopped = this.#running.get(channel)?.stop() ?? false;
		if (stopped)
			this.#options.logger.info({ channel }, "turn stopped by the owner");
		return stopped;
	}

	/**
	 * Runs a task in a fresh, unsaved session with the selected tools and the channel's
	 * confirmation gate, and returns its final text.
	 */
	// pi-lens-ignore: high-fan-out — builds, runs, and disposes one transient session; batch 4 turns it into the core's child-run API
	async #runTask(channel: ChannelKey, task: TransientTask): Promise<string> {
		const { dataDir } = this.#options;
		const { signal } = task;
		// A worker asks nothing: its held actions wait for the owner's next message.
		const worker = await this.#factory.create(
			channel,
			SessionManager.inMemory(this.#factory.workDir()),
			await this.#sessions.gate(channel, false),
			new PromptSlot(),
			ownerAttachmentDir(dataDir, channel),
			undefined,
			"owner",
		);
		const { session } = worker;
		const toolCalls: string[] = [];
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "tool_execution_start") toolCalls.push(event.toolName);
		});
		const abort = () => void session.abort();
		signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(abort, task.timeoutMs);
		try {
			const registered = new Set(session.getAllTools().map((t) => t.name));
			const excluded = new Set([...task.exclude, ASK_USER_TOOL]);
			// A task works at the tier of the turn that started it.
			const tier = this.#turns.get(channel)?.tier ?? "owner";
			worker.tools = this.#factory
				.toolsFor(task.selection)
				.filter(
					(name) =>
						!excluded.has(name) &&
						registered.has(name) &&
						this.#tiers.allows(tier, name),
				);
			session.setActiveToolsByName([...worker.tools]);
			await withoutReplyFiles(() => session.prompt(task.text));
			return workerReport(
				session.messages,
				"the worker stopped before it reported",
			);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			unsubscribe();
			session.dispose();
			task.onFinished?.(toolCalls);
		}
	}

	async startFresh(channel: ChannelKey): Promise<void> {
		await this.#sessions.forget(channel);
		const archived = archiveSessions(this.#factory.sessionDir(channel));
		this.#options.logger.info(
			{ channel, archived },
			"conversation started over",
		);
	}

	async deleteConversation(channel: ChannelKey): Promise<void> {
		await this.#sessions.forget(channel);
		rmSync(this.#factory.sessionDir(channel), { recursive: true, force: true });
		this.#options.logger.info({ channel }, "conversation deleted");
	}

	/** Undefined until the conversation has run a turn since startup. */
	// pi-lens-ignore: pass-through-wrappers — AgentRuntime's port method over the private usage map
	contextUsage(
		channel: ChannelKey,
	): { tokens: number | null; contextWindow: number } | undefined {
		return this.#sessions.usage.get(channel);
	}

	pendingConfirmation(channel: ChannelKey): PendingConfirmation | undefined {
		return this.#sessions.pending(channel);
	}

	/** An agent conversation's held actions, restored from the store after a restart. */
	async heldActions(
		session: ChannelKey,
	): Promise<PendingConfirmation | undefined> {
		const gate = await this.#sessions.gate(session, true);
		return gate.pending();
	}

	async recentTranscript(
		channel: ChannelKey,
		limit: number,
	): Promise<TranscriptEntry[]> {
		const { session } = await this.#sessions.session(channel);
		const entries: TranscriptEntry[] = [];
		for (const message of session.messages) {
			if (message.role !== "user" && message.role !== "assistant") continue;
			const text = textOf(message.content).trim();
			if (text)
				entries.push({
					role: message.role,
					text: text.slice(0, TRANSCRIPT_ENTRY_CHARS),
				});
		}
		return entries.slice(-limit);
	}

	/**
	 * The turn's thinking level: an agent's fixed setting, or the judge's pick, which is kept for the
	 * next turn while the judge is unsure. An agent session also switches to the agent's model here.
	 */
	async #thinkingLevel(
		key: ChannelKey,
		session: AgentSession,
		request: TurnRequest,
	): Promise<ThinkingLevel> {
		const setting = request.agent
			? await this.#useAgentModel(session, request.agent.name)
			: AUTO_THINKING;
		if (setting !== AUTO_THINKING) {
			this.#sessions.judged.delete(key);
			return setting;
		}
		const level = await this.#options.effort.judge(request.text, {
			reply: lastReply(session.messages),
			level: this.#sessions.judged.get(key),
		});
		this.#sessions.judged.set(key, level);
		return level;
	}

	/** Switches an agent session to the agent's current model; returns its thinking setting. */
	async #useAgentModel(
		session: AgentSession,
		name: string,
	): Promise<ThinkingSetting> {
		const agents = this.#options.agents;
		if (!agents)
			throw new ConfigError("agent turns need the runtime's agents option");
		const { model, thinking } = agents.modelOf(name);
		const ref = parseModelRef(model);
		if (
			session.model?.provider !== ref?.provider ||
			session.model?.id !== ref?.id
		) {
			const resolved = ref && this.#modelRuntime.getModel(ref.provider, ref.id);
			if (!resolved)
				throw new AgentRunError(
					`${name}'s model ${model} is not available on this host`,
				);
			await session.setModel(resolved);
		}
		return thinking;
	}

	dispose(): void {
		this.#sessions.dispose();
	}
}

function promptImages(attachments: TurnAttachments): PromptImages {
	return attachments.images.map((image) => ({
		type: "image" as const,
		...image,
	}));
}
