import { rmSync } from "node:fs";
import {
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
import { AgentRunError } from "../domain/errors.ts";
import type { TurnRequest } from "../domain/ports.ts";
import { HostStoppingError } from "../errors.ts";
import { assistantName } from "../i18n/index.ts";
import { promptScopeOf } from "../interactions/prompts.ts";
import { MEMORY_TOOLS } from "../modules/memory/owner-memory.ts";
import { withoutReplyFiles } from "../reply-files.ts";
import type { TransientTask } from "../sessions.ts";
import type { Speaker, Tier } from "../speakers.ts";
import { type ToolTiers, toolsForTier, toolTiers } from "../tool-tiers.ts";
import { AbortGuard } from "./abort-guard.ts";
import { bridgeTurnRefusal, chosenAgentModel } from "./bridge-guard.ts";
import { ConversationSessions } from "./conversation-sessions.ts";
import { confirmedTurnText } from "./extensions/confirmation-gate.ts";
import { loadsMemory } from "./extensions/private-memory.ts";
import { missingToolsError } from "./extensions/self-compact-guard.ts";
import { interimPoster } from "./interim-text.ts";
import { preflightTools } from "./preflight-tools.ts";
import { PromptSlot, workTimeout } from "./prompt-slot.ts";
import { carriesMemory, recordMemoryTurn } from "./reader-history.ts";
import type { PiAgentRuntimeOptions, TurnMessage } from "./runtime-types.ts";
import { archiveSessions } from "./session-archive.ts";
import {
	memoryReader,
	refusedSpeaker,
	turnAddressee,
} from "./session-conversation.ts";
import { SessionFactory } from "./session-factory.ts";
import { promptImages, SteerableRun } from "./steerable-run.ts";
import { thinkingLevel } from "./thinking-level.ts";
import { runningCalls } from "./tool-call-scope.ts";
import { transcriptOf, turnAnswer, unspokenTurn } from "./turn-answer.ts";
import { progressReporter } from "./turn-progress.ts";
import { wrapUpTurn } from "./turn-wrapup.ts";
import { workerReport } from "./worker-task.ts";

export {
	type CoreExtensions,
	type LoadedSkill,
	type PiAgentRuntimeOptions,
	sessionExtensions,
} from "./runtime-types.ts";

const MEMORY = new Set<string>(MEMORY_TOOLS);

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
		{ tier: Tier; speaker: Speaker; withheld: boolean }
	>();
	/** Each conversation's turn in progress, which the owner may steer or stop. */
	readonly #running = new Map<ChannelKey, SteerableRun>();
	readonly #memoryTurns = new Map<ChannelKey, () => void>();

	/** Builds the runtime without starting a session; the preflight proves it can run. */
	constructor(options: PiAgentRuntimeOptions) {
		this.#options = options;
		this.#modelRuntime = options.modelRuntime;
		this.#tiers = options.toolTiers ?? toolTiers();
		this.#factory = new SessionFactory(options, {
			speaker: (channel) => this.#turns.get(channel)?.speaker,
			withholdsMemory: (channel) => this.#turns.get(channel)?.withheld === true,
			runTask: (scope, task) => this.#runTask(scope, task),
		});
		this.#sessions = new ConversationSessions(
			options,
			this.#factory,
			this.#tiers,
		);
	}

	/** Resolves the model and required tools in throwaway shared and private sessions, without a turn. */
	async preflight(): Promise<void> {
		const required = this.#factory.requiredTools();
		const registered = await preflightTools(
			this.#factory,
			this.#options.owner,
			required,
		);
		const missing = required.filter((name) => !registered.has(name));
		if (missing.length > 0) throw missingToolsError(missing);
	}

	// pi-lens-ignore: high-complexity, high-fan-out, mixed-async-styles — one turn's lifecycle end to end; batch 4 splits it with the channel router
	async runTurn(request: TurnRequest): Promise<TurnResult> {
		const { logger, turnTimeoutMs = 10 * 60_000 } = this.#options;
		if (!request.speaker) return unspokenTurn();
		// A turn that is only asked for now, such as a group's next member, starts nothing.
		if (this.#options.stopping?.())
			return {
				ok: false,
				error: new AgentRunError(new HostStoppingError().message),
			};
		const key = request.agent?.session ?? request.channel;
		// Resolve current scope; refuse a foreign private speaker before touching its session.
		const conversation = await this.#sessions.conversation(key, request);
		const refused = refusedSpeaker(conversation, request.speaker);
		if (refused) return { ok: false, error: new AgentRunError(refused) };
		const scoped = { ...request, conversation };
		const channelSession = await this.#sessions.freshSession(key, scoped);
		const who = turnAddressee(
			request.speaker,
			channelSession,
			this.#options.owner,
		);
		const { session } = channelSession;
		const agentModel = chosenAgentModel(request.agent?.name, this.#options);
		const bridgeRefused =
			conversation.visibility === "shared"
				? await bridgeTurnRefusal(
						request.agent?.name,
						this.#options,
						{
							messages: session.messages,
							sessionManager: session.sessionManager,
							reader: request.speaker.principalId,
						},
						agentModel,
					)
				: undefined;
		if (bridgeRefused)
			return { ok: false, error: new AgentRunError(bridgeRefused) };
		const level = await thinkingLevel(
			{
				modelRuntime: this.#modelRuntime,
				effort: this.#options.effort,
				judged: this.#sessions.judged,
			},
			key,
			session,
			request,
			agentModel,
		);
		if (session.thinkingLevel !== level) session.setThinkingLevel(level);
		const gate = await this.#sessions.gate(key, request.agent !== undefined);
		const pending = gate.pending();
		const registered = new Set(session.getAllTools().map((tool) => tool.name));
		// The speaker's tier limits the tools.
		const { tier } = request.speaker;
		// An approving turn also has the held calls' tools, which a dispatched worker may have used.
		// The agent server may keep a speaker below the owner tier out of memory: no tools, no block.
		const withheld =
			request.agent !== undefined &&
			this.#options.agents?.memory === "owners" &&
			tier !== "owner";
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
		).filter((name) => !withheld || !MEMORY.has(name));
		const markPrivateMemory = recordMemoryTurn(
			session.sessionManager,
			request.speaker.principalId,
			!withheld &&
				channelSession.memory !== "none" &&
				memoryReader(conversation, request.speaker) !== undefined &&
				loadsMemory(registered),
		);
		this.#memoryTurns.set(key, markPrivateMemory);
		this.#turns.set(key, { tier, speaker: request.speaker, withheld });
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
			who,
			request.speaker,
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
				if (carriesMemory(event.message)) markPrivateMemory();
				turnMessages.push(event.message);
				interim?.messageEnd(event.message);
			}
		});
		const slot = this.#sessions.slot(key);
		slot.bind(
			request.interactive
				? this.#options.prompts?.(request.channel, promptScopeOf(scoped))
				: undefined,
			request.agent?.name ?? assistantName(),
			interim ? () => interim.flush() : undefined,
		);
		// A model that ignores the abort must not hold the turn: its session is disposed of instead.
		const guard = new AbortGuard(session, {
			graceMs: this.#options.turnAbortGraceMs,
			onGiveUp: () => {
				logger.error(
					{ channel: request.channel },
					"turn did not stop after its abort; disposing of its session",
				);
				this.#sessions.drop(key, channelSession);
			},
		});
		// Time spent waiting on the owner's cards does not count towards the timeout.
		const cancelTimeout = workTimeout(turnTimeoutMs, slot, () => {
			logger.warn(
				{ channel: request.channel, turnTimeoutMs },
				"turn timed out; aborting",
			);
			guard.abort();
		});
		const running = new SteerableRun(
			session,
			() => request.steerable === true && !gate.pending(),
			() => guard.abort(),
		);
		this.#running.set(key, running);

		try {
			const attachments = request.attachments ?? NO_ATTACHMENTS;
			const text =
				request.confirmed && pending
					? confirmedTurnText(pending, request.text, who)
					: request.text;
			const prompted = running.run(() =>
				session.prompt(
					withAttachmentsBlock(text, attachments),
					attachments.images.length > 0
						? { images: promptImages(attachments) }
						: undefined,
				),
			);
			// A run abandoned by the guard may still reject later; nobody waits for it then.
			prompted.catch(() => undefined);
			await Promise.race([prompted, guard.gaveUp]);
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
			this.#memoryTurns.delete(key);
			cancelTimeout();
			guard.release();
			slot.unbind();
			unsubscribe();
			progress?.close();
			await interim?.flush();
			await wrapUpTurn({
				key,
				request,
				session,
				gate,
				toolCalls,
				options: this.#options,
				recordUsage: (usage) => this.#sessions.usage.set(key, usage),
			});
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

	/** Runs a task in an unsaved session with the selected tools and conversation's gate. */
	// pi-lens-ignore: high-fan-out — builds, runs, and disposes one transient session; batch 4 turns it into the core's child-run API
	async #runTask(
		scope: { turn: ChannelKey; home: ChannelKey },
		task: TransientTask,
	): Promise<string> {
		const { dataDir } = this.#options;
		const { signal } = task;
		if (this.#options.stopping?.())
			throw new AgentRunError(new HostStoppingError().message);
		// A task works at the tier of the turn that started it; without one there is no tier to take.
		const turn = this.#turns.get(scope.turn);
		if (!turn)
			throw new AgentRunError(
				`a task runs beside a turn of its conversation, at that turn's tier, and ${scope.turn} has no turn running`,
			);
		// A worker inherits the starting turn's conversation and memory policy, without asking.
		const parent = await this.#sessions.session(scope.turn);
		const { conversation, memory } = parent;
		const worker = await this.#factory.create(
			scope.home,
			SessionManager.inMemory(this.#factory.workDir()),
			await this.#sessions.gate(scope.home, false),
			new PromptSlot(),
			ownerAttachmentDir(dataDir, scope.home),
			undefined,
			"owner",
			conversation,
			{ turn: scope.turn, memory },
		);
		const { session } = worker;
		const toolCalls: string[] = [];
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "tool_execution_start") toolCalls.push(event.toolName);
		});
		// A worker whose model ignores the abort is given up on, like a turn's.
		const guard = new AbortGuard(session, {
			graceMs: this.#options.turnAbortGraceMs,
		});
		const abort = () => guard.abort();
		signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(abort, task.timeoutMs);
		try {
			const registered = new Set(session.getAllTools().map((t) => t.name));
			// A worker that loaded the reader's memory may report it: the call that started it, and the
			// calls that one runs within, then record their results as the reader's.
			if (memoryReader(conversation, turn.speaker) && loadsMemory(registered)) {
				parent.draws.drawn(runningCalls());
				this.#memoryTurns.get(scope.turn)?.();
			}
			const { tier } = turn;
			worker.tools = this.#factory
				.taskTools(task.selection, task.exclude)
				.filter(
					(name) => registered.has(name) && this.#tiers.allows(tier, name),
				);
			session.setActiveToolsByName([...worker.tools]);
			const prompted = withoutReplyFiles(() => session.prompt(task.text));
			prompted.catch(() => undefined);
			await Promise.race([prompted, guard.gaveUp]);
			return workerReport(
				session.messages,
				"the worker stopped before it reported",
			);
		} finally {
			clearTimeout(timer);
			guard.release();
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
		return this.#sessions.held(session);
	}

	async recentTranscript(
		channel: ChannelKey,
		limit: number,
	): Promise<TranscriptEntry[]> {
		await this.#sessions.held(channel);
		return transcriptOf(await this.#sessions.messages(channel), limit);
	}

	dispose(): void {
		this.#sessions.dispose();
	}
}
