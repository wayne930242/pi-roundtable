import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentSession,
	createAgentSession,
	createBashToolDefinition,
	DefaultResourceLoader,
	type ModelRuntime,
	type SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { channelSegment } from "../attachments/attachment-dir.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import { ConfigError } from "../domain/errors.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import type { LinkedSessions } from "../plugin.ts";
import {
	planOrder,
	type SessionContext,
	type SessionConversation,
	type SessionPlan,
	type ToolSelection,
	type TransientTask,
} from "../sessions.ts";
import { activeToolsExtension } from "../shared/active-tools.ts";
import { packageDir } from "../shared/package-dir.ts";
import { readAttachmentExtension } from "../shared/read-attachment-tool.ts";
import { type Speaker, THE_SPEAKER } from "../speakers.ts";
import { currentToolNames } from "../tool-tiers.ts";
import {
	CompactionTiers,
	compactionEngine,
	HARD_COMPACT_TOKENS,
} from "./compaction-tiers.ts";
import { ASK_USER_TOOL, askUserExtension } from "./extensions/ask-user.ts";
import {
	type ConfirmationGate,
	confirmationGateExtension,
} from "./extensions/confirmation-gate.ts";
import {
	MemoryDraws,
	privateCompaction,
	privateMemoryExtension,
} from "./extensions/private-memory.ts";
import {
	COMPACT_TOOL,
	selfCompactGuardExtension,
} from "./extensions/self-compact-guard.ts";
import type { PromptSlot } from "./prompt-slot.ts";
import type {
	ChannelSession,
	CompactionEnd,
	PiAgentRuntimeOptions,
} from "./runtime-types.ts";
import {
	type LoadedSkill,
	revisionsKey,
	sessionExtensions,
	skillsKey,
} from "./runtime-types.ts";
import {
	memoryReader,
	sessionAddressee,
	turnAddressee,
} from "./session-conversation.ts";

/** What a session factory asks of the runtime that owns the turns. */
export interface SessionFactoryDeps {
	/** The person the conversation's running turn is for. */
	speaker(channel: ChannelKey): Speaker | undefined;
	/** Whether the conversation's running turn loads no memory, as the agent server's option keeps a speaker out of it. */
	withholdsMemory(channel: ChannelKey): boolean;
	/**
	 * Runs a task beside the conversation of `home`, under its gate, at the tier of the running
	 * turn of `turn`: the conversation's own channel, or an agent's seat in a group.
	 */
	runTask(
		scope: { turn: ChannelKey; home: ChannelKey },
		task: TransientTask,
	): Promise<string>;
}

/** Builds Pi sessions for the runtime: one resource loader per session, its extensions in order. */
export class SessionFactory {
	readonly #options: PiAgentRuntimeOptions;
	readonly #modelRuntime: ModelRuntime;
	readonly #deps: SessionFactoryDeps;
	/** The linked session parts, with each package's directory; resolved on first use. */
	#linked: (LinkedSessions & { extensionPaths: string[] }) | undefined;

	constructor(options: PiAgentRuntimeOptions, deps: SessionFactoryDeps) {
		this.#options = options;
		this.#modelRuntime = options.modelRuntime;
		this.#deps = deps;
	}

	link(): LinkedSessions & { extensionPaths: string[] } {
		if (!this.#linked) {
			const linked = this.#options.sessions();
			this.#linked = {
				...linked,
				extensionPaths: linked.piPackages.map((name) => packageDir(name)),
			};
		}
		return this.#linked;
	}

	/**
	 * The system prompt of a non-agent conversation of the kind: a plugin's persona, else for
	 * "owner" none. A kind nobody wrote a persona for is refused, never given the owner's.
	 */
	personaOf(kind: string): string {
		const contributed = this.link().persona(kind);
		if (contributed !== undefined) return contributed;
		if (kind === "owner") return "";
		throw new ConfigError(
			`no persona is registered for the conversation kind "${kind}". A plugin adds one with \`personas: [{ kind: "${kind}", prompt() { ... } }]\`, or its claim must start conversations of a kind that has one.`,
		);
	}

	get plan(): SessionPlan {
		return this.link().plan;
	}

	toolsFor(selection: ToolSelection): string[] {
		const groups = planOrder(this.plan).flatMap(
			(tool) => tool.snapshot().groups ?? [],
		);
		return [
			...currentToolNames(selection.tools, this.#options.logger),
			COMPACT_TOOL,
			ASK_USER_TOOL,
			...groups
				.filter((group) => selection.groups.includes(group.name))
				.flatMap((group) => group.tools),
		];
	}

	/** The tools of a task beside a turn: its selection without what it excludes, and it never asks. */
	taskTools(selection: ToolSelection, exclude: readonly string[]): string[] {
		const excluded = new Set([
			...currentToolNames(exclude, this.#options.logger),
			ASK_USER_TOOL,
		]);
		return this.toolsFor(selection).filter((name) => !excluded.has(name));
	}

	/** Every tool startup refuses to run without: the plugins', the core's, and the session tools'. */
	requiredTools(): string[] {
		return currentToolNames(
			[
				...this.link().requiredTools,
				COMPACT_TOOL,
				ASK_USER_TOOL,
				...planOrder(this.plan).flatMap(
					(tool) => tool.snapshot().requiredTools ?? [],
				),
			],
			this.#options.logger,
		);
	}

	/** Waits for the tools the session tools register late, such as pi-mcp-adapter's after its eager connection. */
	async #awaitTools(
		session: AgentSession,
		expected: readonly string[],
	): Promise<void> {
		const deadline = Date.now() + (this.#options.mcpConnectTimeoutMs ?? 30_000);
		while (Date.now() < deadline) {
			const registered = new Set(
				session.getAllTools().map((tool) => tool.name),
			);
			if (expected.every((name) => registered.has(name))) return;
			await Bun.sleep(250);
		}
	}

	workDir(): string {
		const dir = join(this.#options.dataDir, "work");
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	sessionDir(channel: ChannelKey): string {
		return join(this.#options.dataDir, "sessions", channelSegment(channel));
	}

	/** An agent's carried skills; owner sessions carry none. */
	skillsOf(agent: AgentTurnScope | undefined): readonly LoadedSkill[] {
		const agents = this.#options.agents;
		return agent && agents ? agents.skills(agent.name) : [];
	}

	/** Agents work in their shared workspace; owner sessions in the assistant's own. */
	cwd(agent: AgentTurnScope | undefined): string {
		const agents = this.#options.agents;
		if (!agent || !agents) return this.workDir();
		mkdirSync(agents.workDir, { recursive: true });
		return agents.workDir;
	}

	/**
	 * Logs who compacted a conversation, the compaction extension or Pi's summary, by how much, and the context size
	 * that compacts it next, so a move to the hard ceiling shows.
	 */
	#logCompaction(
		channel: ChannelKey,
		event: CompactionEnd,
		session: AgentSession,
	): void {
		const { logger } = this.#options;
		const trigger = event.reason === "manual" ? "self" : event.reason;
		if (!event.result) {
			logger.warn(
				{
					channel,
					trigger,
					aborted: event.aborted,
					error: event.errorMessage,
				},
				"compaction failed",
			);
			return;
		}
		const { model, settingsManager } = session;
		logger.info(
			{
				channel,
				trigger,
				engine: compactionEngine(
					event.result.details,
					this.plan.compaction?.engine,
				),
				tokensBefore: event.result.tokensBefore,
				tokensAfter: event.result.estimatedTokensAfter,
				nextCompactionAt:
					model &&
					model.contextWindow -
						settingsManager.getCompactionSettings(model).reserveTokens,
			},
			"conversation compacted",
		);
	}

	/**
	 * Each channel gets its own resource loader: Pi binds extension actions such as
	 * setActiveTools to the loader's shared runtime, so sessions sharing a loader would
	 * act on whichever session bound last.
	 */
	// pi-lens-ignore: long-parameter-list, high-fan-out — the build inputs of one session; its SessionContext is derived here from them
	async create(
		channel: ChannelKey,
		sessionManager: SessionManager,
		gate: ConfirmationGate,
		slot: PromptSlot,
		attachmentDir: string,
		agent: AgentTurnScope | undefined,
		kind: string,
		/** Whom the conversation serves, fixed for the session's life. */
		conversation: SessionConversation,
		/**
		 * A worker's: the conversation whose running turn it acts in, and that conversation's memory
		 * policy, which it keeps rather than reading its own kind's.
		 */
		worker?: { turn: ChannelKey; memory: SessionContext["memory"] },
	): Promise<ChannelSession> {
		const { agentDir, model, thinking, logger } = this.#options;
		// An agent's prompt is set before each run; the other kinds are refused here, before a session is built.
		const persona = agent ? undefined : this.personaOf(kind);
		const skills = this.skillsOf(agent);
		const addressee = agent
			? THE_SPEAKER
			: sessionAddressee(conversation, this.#options.owner);
		// An agent's conversations read each speaker's memory; another kind's, as its persona says;
		// a worker's, as the conversation it works for.
		const memory =
			worker?.memory ??
			(agent ? "speaker" : (this.link().personaMemory?.(kind) ?? "speaker"));
		// The running turn is the conversation's: an agent's seat in a group, or its own channel; a
		// worker's is the turn that started it.
		const turnKey = worker?.turn ?? agent?.session ?? channel;
		const deps = this.#deps;
		const state = {
			tools: [] as readonly string[],
			revisions: revisionsKey(this.plan),
			skills: skillsKey(skills),
			conversation,
			addressee,
			// A turn the agent server keeps out of memory reads none, and so does a worker beside it.
			get memory(): SessionContext["memory"] {
				return deps.withholdsMemory(turnKey) ? "none" : memory;
			},
			draws: new MemoryDraws(),
		};
		const awaited = planOrder(this.plan).flatMap(
			(tool) => tool.snapshot().awaitTools ?? [],
		);
		const cwd = this.cwd(agent);
		const agents = agent ? this.#options.agents : undefined;
		if (agent && !agents)
			throw new ConfigError("agent turns need the runtime's agents option");
		const tiers = new CompactionTiers(
			sessionManager,
			(provider, id) =>
				this.#modelRuntime.getModel(provider, id)?.contextWindow,
			this.plan.compaction?.engine,
		);
		const context: SessionContext = {
			kind: agent ? "agent" : kind,
			homeChannel: channel,
			turnChannel: agent && agents ? agents.turnChannel(agent) : channel,
			compaction: {
				// A shared conversation's compactor summarizes no one's private memory.
				wrap: (compactor) =>
					tiers.wrapCompactor(
						compactor,
						(bypass) =>
							logger.info(
								{ channel, ...bypass, ceiling: HARD_COMPACT_TOKENS },
								"compaction skips the extension for Pi's summary",
							),
						conversation.visibility === "shared"
							? (event) =>
									privateCompaction(
										event.preparation,
										event.branchEntries.flatMap((entry) =>
											entry.type === "message" ? [entry.message] : [],
										),
									)
							: undefined,
					),
			},
			conversation,
			addressee,
			get memory() {
				return state.memory;
			},
			speaker: () => this.#deps.speaker(turnKey),
			runTask: (task) =>
				this.#deps.runTask({ turn: turnKey, home: channel }, task),
		};
		if (agent) context.agent = agent;
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noExtensions: true,
			noSkills: true,
			additionalSkillPaths: skills.map((skill) => skill.file),
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: this.link().extensionPaths,
			extensionFactories: sessionExtensions(this.plan, context, {
				readAttachment: readAttachmentExtension(attachmentDir),
				confirmationGate: confirmationGateExtension(gate, slot),
				askUser: askUserExtension(slot, addressee, () =>
					turnAddressee(
						this.#deps.speaker(turnKey),
						state,
						this.#options.owner,
					),
				),
				selfCompactGuard: selfCompactGuardExtension(),
				// Each request carries no one's memory but the running turn's reader's.
				privateMemory: privateMemoryExtension(
					conversation.visibility === "shared",
					() =>
						deps.withholdsMemory(turnKey)
							? undefined
							: memoryReader(conversation, deps.speaker(turnKey)),
					state.draws,
				),
				activeTools: activeToolsExtension(() => state.tools),
			}),
			// An agent's prompt is set before each run by the agent-prompt extension.
			appendSystemPrompt: persona === undefined ? [] : [persona],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			// Pi's bash under its own name, run with TMPDIR at the agents' scratch dir.
			...(agents?.scratchDir
				? { customTools: [scratchBash(cwd, agents.scratchDir)] }
				: {}),
			thinkingLevel: thinking,
			modelRuntime: this.#modelRuntime,
			resourceLoader,
			sessionManager,
			// Large windows compact through the extension at SOFT_COMPACT_TOKENS, and through pi's summary
			// past HARD_COMPACT_TOKENS.
			settingsManager: tiers.settings(),
		});

		// Extension providers such as claude-bridge exist only after the session loads its extensions.
		const resolved = this.#modelRuntime.getModel(model.provider, model.id);
		if (!resolved) {
			session.dispose();
			throw new ConfigError(
				`model ${model.provider}/${model.id} is not available`,
			);
		}
		await session.setModel(resolved);
		await this.#awaitTools(session, awaited);
		session.subscribe((event) => {
			if (event.type === "compaction_end")
				this.#logCompaction(channel, event, session);
		});
		return Object.assign(state, { session });
	}
}

/** Pi's bash tool with TMPDIR set to `scratchDir`, so `mktemp` and tools write there. */
export function scratchBash(cwd: string, scratchDir: string): ToolDefinition {
	// SAFETY: Pi's bash definition is a ToolDefinition typed by its own parameter schema, which the session takes as any custom tool.
	return createBashToolDefinition(cwd, {
		spawnHook: (context) => ({
			...context,
			env: { ...context.env, TMPDIR: scratchDir },
		}),
	}) as unknown as ToolDefinition;
}
