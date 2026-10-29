import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { CharacterInput } from "../../characters/index.ts";
import type { TurnAttachments } from "../domain/attachment.ts";
import type { ChannelKey, TurnResult } from "../domain/conversation.ts";
import { AgentError, ScheduleError } from "../domain/errors.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import type { ThinkingSetting } from "../models.ts";
import { SHELL_TOOLS } from "../modules/host-shell/shell-policy.ts";
import type { PromptVersion } from "../modules/prompts/prompt-history.ts";
import type { ResolvedSkill } from "../modules/skills/skill-rules.ts";
import type { AgentChange, AgentTeam } from "../services.ts";
import type { TurnSelection } from "../sessions.ts";
import { type Speaker, THE_SPEAKER } from "../speakers.ts";
import { agentSystemPrompt } from "./agent-prompt.ts";
import type { Agent } from "./agent-store.ts";
import {
	AGENT_TOOLS,
	type AgentOps,
	type AvatarMode,
	agentToolsExtension,
	MESSAGE_AGENT_TOOL,
} from "./agent-tools.ts";
import { TeamEditing } from "./team-editing.ts";
import {
	agentRoomKey,
	channelOwner,
	coordinatorOf,
	discordIdOf,
	discordKey,
	keysOf,
	roomSurfaceOf,
} from "./team-keys.ts";
import {
	layoutText,
	planArrangement,
	resolveArrangement,
} from "./team-layout.ts";
import { TeamLifecycle } from "./team-lifecycle.ts";
import type { AgentTeamOptions, TeamContext } from "./team-options.ts";
import { type TeamStatus, teamStatus } from "./team-status.ts";
import {
	agentDetails,
	channelIdFromRef,
	messageLine,
	NO_CHANNELS,
	teamListText,
} from "./team-text.ts";
import { TeamTurns } from "./team-turns.ts";

export type { AgentTeamOptions } from "./team-options.ts";
export type { AgentStatus, GroupStatus, TeamStatus } from "./team-status.ts";

const READ_LIMIT = 50;

/**
 * The agent server: every agent is one channel and one conversation with every owner tool.
 * This team creates, changes, arranges, and archives agents and groups; its TeamTurns runs
 * their turns, group rounds, and messages between agents.
 */
export class DiscordAgentTeam implements AgentOps, AgentTeam {
	readonly #options: AgentTeamOptions;
	readonly #turns: TeamTurns;
	readonly #listeners: (() => void)[] = [];
	readonly #context: TeamContext;
	readonly #lifecycle: TeamLifecycle;
	readonly #editing: TeamEditing;

	constructor(options: AgentTeamOptions) {
		this.#options = options;
		this.#turns = new TeamTurns({
			...options,
			selection: (scope) => this.selection(scope),
			changed: () => this.#changed(),
		});
		this.#context = {
			options,
			turns: this.#turns,
			changed: () => {
				this.#changed();
				options.events?.changed();
			},
			modelOf: (name) => this.modelOf(name),
			retitle: (group) => this.#lifecycle.retitle(group),
		};
		this.#lifecycle = new TeamLifecycle(this.#context);
		this.#editing = new TeamEditing(this.#context);
	}

	get guildId(): string {
		return this.#options.guildId;
	}

	/** Called when a turn starts or ends and when an agent or group changes. */
	onChange(listener: () => void): void {
		this.#listeners.push(listener);
	}

	#changed(): void {
		for (const listener of this.#listeners) listener();
	}

	/** Every active agent and group, with what each is doing now. */
	status(): Promise<TeamStatus> {
		return teamStatus(this.#context);
	}

	/**
	 * The agent or group that owns a channel of the agent server: by Discord channel, or by room on
	 * a surface that hosts rooms.
	 */
	owns(channel: ChannelKey): "agent" | "group" | undefined {
		const { store, surfaces } = this.#options;
		return channelOwner(
			store,
			channel,
			discordIdOf(channel) === undefined
				? (surfaces?.roomSurfaces() ?? [])
				: [],
		);
	}

	/**
	 * The name of the coordinator: the agent in the entry channel, or, on a host without Discord,
	 * the one the configuration names; undefined while none is active.
	 */
	coordinator(): string | undefined {
		return coordinatorOf(this.#options.store, this.#options)?.name;
	}

	/**
	 * Every key an agent or group is addressed by: its Discord channel when it has one, then its
	 * room on each surface that hosts rooms; empty for an unknown name.
	 */
	roomsOf(name: string): ChannelKey[] {
		const { store, surfaces } = this.#options;
		return keysOf(store, name, surfaces?.roomSurfaces() ?? []);
	}

	/** The tools every agent turn runs with: the plugins', plus the shell and agent tools. */
	selection(scope?: AgentTurnScope): TurnSelection {
		const plugged = this.#options.pluginSelection();
		return {
			id: "agent",
			tools: [
				...new Set([
					...plugged.tools,
					...SHELL_TOOLS,
					// Group members hand off by mentioning each other, so a group seat has no message_agent.
					...AGENT_TOOLS.filter(
						(tool) => !(scope?.group && tool === MESSAGE_AGENT_TOOL),
					),
					...(this.#options.pluginTools?.() ?? []),
				]),
			],
			groups: plugged.groups,
		};
	}

	/** The system prompt addition of an agent session, read before each of its runs. */
	systemPrompt(scope: AgentTurnScope): string {
		const {
			store,
			workDir,
			sharedPrompt,
			guestPrompt,
			owner,
			shellUser,
			scratchDir,
		} = this.#options;
		const agent = store.agent(scope.name);
		if (!agent) throw new AgentError(`no agent ${scope.name}`);
		const shared =
			typeof sharedPrompt === "function" ? sharedPrompt() : sharedPrompt;
		const guest =
			typeof guestPrompt === "function" ? guestPrompt() : guestPrompt;
		const group = scope.group ? store.group(scope.group) : undefined;
		const coordinator = coordinatorOf(store, this.#options);
		const speaker = this.#turns.speakerOf(scope);
		const base = agentSystemPrompt({
			agent,
			...(speaker ? { speaker } : {}),
			...(coordinator ? { coordinator } : {}),
			shared,
			...(guest ? { guestShared: guest } : {}),
			workDir,
			owner,
			shellUser,
			...(scratchDir ? { scratchDir } : {}),
			images: this.#images(),
			...(group
				? {
						group: {
							group,
							members: group.members
								.map((m) => store.agent(m))
								.filter((m): m is Agent => m !== undefined),
						},
					}
				: {}),
		});
		const added = (this.#options.promptSections?.() ?? []).flatMap(
			(section) =>
				section.build({
					agent: { name: agent.name, displayName: agent.displayName },
					speaker,
					scope,
				}) ?? [],
		);
		return [base, ...added.filter((text) => text.trim() !== "")].join("\n\n");
	}

	/** The model and thinking setting of an agent's next run: its own, or the assistant's. */
	modelOf(name: string): { model: string; thinking: ThinkingSetting } {
		const { store, models } = this.#options;
		const agent = store.agent(name);
		return {
			model: agent?.model ?? models.defaults.model,
			thinking: agent?.thinking ?? models.defaults.thinking,
		};
	}

	/** The assistant's model and thinking setting, which agents without their own follow. */
	defaultModel(): { model: string; thinking: ThinkingSetting } {
		return this.#options.models.defaults;
	}

	/** Models an agent can be set to: every one the host runs, `current` first when given. */
	async usableModels(current?: string): Promise<string[]> {
		const usable = await this.#options.models.usable();
		return current ? [current, ...usable.filter((m) => m !== current)] : usable;
	}

	/** Whether agents can be offered generate_image: an image provider is configured. */
	#images(): boolean {
		return this.#options.studio.canDraw !== false;
	}

	/** The agent tools of one agent session. */
	extension(scope: AgentTurnScope): ExtensionFactory {
		return agentToolsExtension(this, scope, THE_SPEAKER, {
			skills: this.#options.skills !== undefined,
		});
	}

	/** The skill files an agent's sessions load, built-in ones included; none while the skills addon is off. */
	skillsOf(name: string): ResolvedSkill[] {
		return this.#options.skills?.carried(name).skills ?? [];
	}

	/**
	 * Another active agent's channel, for schedule_list: its room on the surface `near` is on when
	 * that surface hosts rooms, otherwise its Discord channel, otherwise its room on the first
	 * surface that hosts rooms.
	 */
	channelOf(name: string, near?: ChannelKey): ChannelKey {
		try {
			const agent = this.#options.store.activeAgent(name);
			const rooms = this.#options.surfaces?.roomSurfaces() ?? [];
			const surface = near === undefined ? undefined : roomSurfaceOf(near);
			if (surface !== undefined && rooms.includes(surface))
				return agentRoomKey(surface, name);
			if (agent.channelId) return discordKey(agent.channelId);
			const room = rooms[0];
			if (room === undefined)
				throw new AgentError(`${name} has no channel yet`);
			return agentRoomKey(room, name);
		} catch (error) {
			throw new ScheduleError(
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	// ── Startup and archive, run by TeamLifecycle ──────────────────────────

	/**
	 * Inserts the seed agents, gives every active agent a channel, archives agents and groups
	 * whose channels were deleted while the assistant was down, and dresses agents without a
	 * character in the background.
	 */
	start(): Promise<void> {
		return this.#lifecycle.start();
	}

	/** Ends the background work the team started. */
	stop(): void {
		this.#lifecycle.stop();
	}

	/** Starts an agent's or every group member's conversation over; call inside the channel's queue. */
	startFresh(channel: ChannelKey): Promise<void> {
		return this.#lifecycle.startFresh(channel);
	}

	/** A deleted channel archives the agent or group that owned it. */
	channelDeleted(channelId: string): Promise<void> {
		return this.#lifecycle.channelDeleted(channelId);
	}

	/** Archives an agent or group like a deleted channel, keeping its channel under Archive. */
	archive(caller: AgentTurnScope | undefined, name: string): Promise<string> {
		return this.#lifecycle.archive(caller, name);
	}

	/** Returns an archived agent or group to the active ones; see `AgentTeam.restore`. */
	restore(name: string): Promise<string> {
		return this.#lifecycle.restore(name);
	}

	/** Deletes an archived agent or group for good; see `AgentTeam.remove`. */
	remove(name: string, cleanup?: () => Promise<void>): Promise<string> {
		return this.#lifecycle.remove(name, cleanup);
	}

	// ── Turns, run by TeamTurns ────────────────────────────────────────────

	/**
	 * The owner's message in an agent's channel; call inside the channel's queue. `text`
	 * carries the reference, `replyText` is what they typed.
	 */
	answerOwner(
		channel: ChannelKey,
		speaker: Speaker,
		text: string,
		replyText: string,
		attachments: TurnAttachments,
	): Promise<TurnResult> {
		return this.#turns.answerOwner(
			channel,
			speaker,
			text,
			replyText,
			attachments,
		);
	}

	/**
	 * A schedule's or a report's turn in an agent's channel; call inside its queue. A report's
	 * turn is interactive: it may ask the owner on cards.
	 */
	answerBackground(
		channel: ChannelKey,
		speaker: Speaker,
		text: string,
		interactive = false,
	): Promise<TurnResult> {
		return this.#turns.answerBackground(channel, speaker, text, interactive);
	}

	/** One owner message in a group channel, answered by a round of members; call inside the queue. */
	answerGroup(
		channel: ChannelKey,
		speaker: Speaker,
		text: string,
		replyText: string,
		attachments: TurnAttachments,
		repliedToName: string | undefined,
	): Promise<void> {
		return this.#turns.answerGroup(
			channel,
			speaker,
			text,
			replyText,
			attachments,
			repliedToName,
		);
	}

	/** Posts text under the caller's name in the channel of its turn. */
	postAs(caller: AgentTurnScope, text: string): Promise<void> {
		return this.#turns.postAs(caller, text);
	}

	/** The channel the scope's turns run in: the group's in a group round, otherwise its own. */
	turnChannel(scope: AgentTurnScope): ChannelKey {
		return this.#turns.turnChannel(scope);
	}

	/** The assistant's own notice, posted in the coordinator's channel under its name. */
	announce(text: string): Promise<void> {
		return this.#turns.announce(text);
	}

	message(caller: AgentTurnScope, to: string, text: string): string {
		return this.#turns.message(caller, to, text);
	}

	async read(
		channel: string,
		around: string | undefined,
		limit: number | undefined,
	): Promise<string> {
		const { channels } = this.#options;
		if (!channels) throw new AgentError(NO_CHANNELS);
		const id = channelIdFromRef(channel);
		const messages = await channels.read(id, {
			limit: Math.min(Math.max(limit ?? 20, 1), READ_LIMIT),
			...(around ? { around } : {}),
		});
		return messages.length > 0
			? messages.map(messageLine).join("\n")
			: `<#${id}> has no messages there.`;
	}

	// ── AgentOps ───────────────────────────────────────────────────────────

	async list(): Promise<string> {
		const { store, channels } = this.#options;
		const list = teamListText(store);
		return channels
			? `${list}\n\n${layoutText(await channels.layout(), store)}`
			: list;
	}

	/**
	 * Sorts agent and group channels into team categories and orders them (spec behavior 57):
	 * the listed categories and channels first, everything else after in its current order. A
	 * wrong entry refuses the whole call before anything moves.
	 */
	async arrange(
		entries: { category: string; names: string[] }[],
	): Promise<string> {
		const { store, channels, logger } = this.#options;
		if (!channels) throw new AgentError(NO_CHANNELS);
		const listed = resolveArrangement(entries, store);
		const { layout, remove } = planArrangement(listed, await channels.layout());
		await channels.arrange(layout, remove);
		logger.info(
			{ entries: listed.map((l) => l.category), removed: remove.length },
			"agent channels arranged",
		);
		const removed =
			remove.length > 0
				? ` ${remove.length} empty team categories were deleted.`
				: "";
		return `Arranged the channels.${removed}\n\n${layoutText(await channels.layout(), store)}`;
	}

	get(name: string): string {
		const { store, models, skills } = this.#options;
		const agent = store.agent(name);
		if (!agent)
			throw new AgentError(`There is no agent "${name}"; see agent_list.`);
		return agentDetails(
			agent,
			models.defaults,
			skills?.describeCarried(agent.name),
		);
	}

	// ── Editing, run by TeamEditing ────────────────────────────────────────

	/**
	 * Changes an agent's display name, prompt, model, or thinking level; `default` returns the
	 * model or thinking level to the assistant's. A model must be one the host runs.
	 */
	update(name: string, change: AgentChange, by?: string): Promise<string> {
		return this.#editing.update(name, change, by);
	}

	/** The changes of an agent's prompt, newest first. */
	async promptHistory(name: string, limit?: number): Promise<PromptVersion[]> {
		if (!this.#options.store.agent(name))
			throw new AgentError(`There is no agent "${name}".`);
		return this.#options.store.promptHistory(name, limit);
	}

	create(
		caller: AgentTurnScope,
		input: Parameters<TeamEditing["create"]>[1],
	): Promise<string> {
		return this.#editing.create(caller, input);
	}

	/** An owner creates an agent outside any agent turn; see `AgentTeam.createAgent`. */
	createAgent(
		by: Speaker,
		input: Parameters<TeamEditing["createFor"]>[1],
	): Promise<Agent> {
		return this.#editing.createFor(by, input);
	}

	/** Changes an agent's look; see `AgentTeam.dress`. */
	dress(name: string, input: CharacterInput): Promise<Agent> {
		return this.#editing.dress(name, input);
	}

	/** The agent tool that changes a look; see `AgentTeam.dress`. */
	avatar(name: string, look: CharacterInput): Promise<string> {
		return this.#editing.avatar(name, look);
	}

	/** @deprecated Use `dress`; removed in 1.0. Draws and stores a new picture. */
	redrawAvatar(name: string, mode: AvatarMode, text?: string): Promise<Agent> {
		return this.#editing.redrawAvatar(name, mode, text);
	}

	createGroup(
		input: Parameters<TeamEditing["createGroup"]>[0],
	): Promise<string> {
		return this.#editing.createGroup(input);
	}

	updateGroup(
		name: string,
		change: Parameters<TeamEditing["updateGroup"]>[1],
	): Promise<string> {
		return this.#editing.updateGroup(name, change);
	}
}
