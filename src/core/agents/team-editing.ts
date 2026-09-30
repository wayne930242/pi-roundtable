import { AgentError } from "../domain/errors.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import { assistantName } from "../i18n/index.ts";
import { addressee } from "../speakers.ts";
import { openingTaskText } from "./agent-prompt.ts";
import { modelSetting, thinkingSetting } from "./agent-settings.ts";
import type { Agent } from "./agent-store.ts";
import type { AvatarMode } from "./agent-tools.ts";
import { channelKey } from "./team-keys.ts";
import { groupTopic, teamCategory } from "./team-layout.ts";
import type { TeamContext } from "./team-options.ts";

/** Creating and changing agents, their avatars, and groups. */
export class TeamEditing {
	readonly #ctx: TeamContext;

	constructor(ctx: TeamContext) {
		this.#ctx = ctx;
	}

	/**
	 * Changes an agent's display name, prompt, model, or thinking level; `default` returns the
	 * model or thinking level to the assistant's. A model must be one the host runs.
	 */
	async update(
		name: string,
		change: {
			displayName?: string;
			prompt?: string;
			model?: string;
			thinking?: string;
		},
	): Promise<string> {
		const { store, logger } = this.#ctx.options;
		if (Object.values(change).every((value) => value === undefined))
			throw new AgentError(
				"Give display_name, prompt, model, or thinking to change.",
			);
		const model = await modelSetting(change.model, () =>
			this.#ctx.options.models.usable(),
		);
		const thinking = thinkingSetting(change.thinking);
		const agent = await store.updateAgent(name, {
			...(change.displayName !== undefined
				? { displayName: change.displayName }
				: {}),
			...(change.prompt !== undefined ? { prompt: change.prompt } : {}),
			...(model !== undefined ? { model } : {}),
			...(thinking !== undefined ? { thinking } : {}),
		});
		logger.info(
			{
				agent: name,
				fields: Object.keys(change).filter(
					(key) => change[key as keyof typeof change] !== undefined,
				),
				...(model !== undefined ? { model } : {}),
				...(thinking !== undefined ? { thinking } : {}),
			},
			"agent updated",
		);
		if (change.displayName !== undefined)
			for (const group of store.groups())
				if (group.status === "active" && group.members.includes(name))
					this.#ctx.retitle(group);
		this.#ctx.changed();
		const { model: runs, thinking: level } = this.#ctx.modelOf(name);
		return `Updated "${agent.displayName}" (${agent.name}); it applies from its next turn. It runs ${runs} with thinking ${level}.`;
	}

	async create(
		caller: AgentTurnScope,
		input: {
			name: string;
			displayName: string;
			prompt: string;
			avatarPrompt: string;
			task: string;
			category?: string;
			skills?: string[];
		},
	): Promise<string> {
		const speaker = this.#ctx.turns.speakerOf(caller);
		if (!speaker)
			throw new AgentError(
				"agent_create can only be used during an agent turn.",
			);
		const { store, channels, queue, skills, logger } = this.#ctx.options;
		const { category, skills: carried = [], ...fields } = input;
		const parent = teamCategory(category, "Agents");
		store.checkNewName(input.name);
		skills.checkRegistered(carried);
		const channelId = await channels.createChannel(
			input.name,
			input.displayName,
			parent,
		);
		const agent = await store.createAgent({ ...fields, channelId });
		if (carried.length > 0) await skills.attach(agent.name, carried, []);
		logger.info({ agent: agent.name, by: caller.name }, "agent created");
		this.#ctx.changed();
		const avatar = await this.#redraw(agent.name, "redraw").then(
			() => "its avatar is drawn",
			(error: unknown) =>
				`its avatar could not be drawn (${error instanceof Error ? error.message : String(error)}), so it uses ${assistantName()}'s for now`,
		);
		const home = channelKey(channelId);
		const creator = store.agent(caller.name);
		void queue
			.run(home, () =>
				this.#ctx.turns.answerBackground(
					home,
					speaker,
					openingTaskText(
						creator,
						input.task,
						addressee(speaker, this.#ctx.options.owner),
					),
				),
			)
			.catch((error: unknown) =>
				logger.error({ agent: agent.name, err: error }, "opening turn failed"),
			);
		return `Created "${agent.displayName}" (${agent.name}) in <#${channelId}>; ${avatar}. It is starting on its opening task now.`;
	}

	async avatar(name: string, mode: AvatarMode, text?: string): Promise<string> {
		await this.#redraw(name, mode, text);
		return `The new avatar of "${this.#ctx.options.store.agent(name)?.displayName ?? name}" shows from its next message.`;
	}

	/** Draws and stores a new picture; the owner's panel and the agent tool both use it. */
	async redrawAvatar(
		name: string,
		mode: AvatarMode,
		text?: string,
	): Promise<Agent> {
		return this.#redraw(name, mode, text);
	}

	async #redraw(name: string, mode: AvatarMode, text?: string): Promise<Agent> {
		const { store, studio, logger } = this.#ctx.options;
		const agent = store.activeAgent(name);
		if (mode !== "redraw" && !text?.trim())
			throw new AgentError(
				mode === "edit"
					? "Give the edit instruction as text."
					: "Give the new avatar prompt as text.",
			);
		const avatarPrompt =
			mode === "new_prompt" ? (text as string) : agent.avatarPrompt;
		if (mode === "new_prompt") await store.updateAgent(name, { avatarPrompt });
		let hash: string;
		try {
			hash =
				mode === "edit"
					? await studio.edit(agent.avatarHash, text as string)
					: await studio.draw(avatarPrompt);
		} catch (error) {
			logger.warn({ agent: name, mode, err: error }, "avatar drawing failed");
			throw new AgentError(
				`The avatar could not be drawn: ${error instanceof Error ? error.message : String(error)}. The previous picture stays.`,
			);
		}
		logger.info({ agent: name, mode }, "avatar redrawn");
		return store.updateAgent(name, { avatarHash: hash });
	}

	async createGroup(input: {
		name: string;
		displayName: string;
		members: string[];
		host?: string;
		category?: string;
	}): Promise<string> {
		const { store, channels, logger } = this.#ctx.options;
		const { category, ...fields } = input;
		const parent = teamCategory(category, "Groups");
		const host =
			input.host ??
			(input.members.includes("coordinator")
				? "coordinator"
				: (input.members[0] ?? ""));
		store.checkNewGroup(input.name, input.members, host);
		const topic = groupTopic(
			{ ...fields, host, channelId: "", status: "active" },
			store,
		);
		const channelId = await channels.createChannel(input.name, topic, parent);
		const group = await store.createGroup({ ...fields, host, channelId });
		logger.info({ group: group.name, members: group.members }, "group created");
		this.#ctx.changed();
		return `Created the group "${group.displayName}" in <#${channelId}> with ${group.members.join(", ")}; host ${group.host}.`;
	}

	async updateGroup(
		name: string,
		change: { displayName?: string; members?: string[]; host?: string },
	): Promise<string> {
		const group = await this.#ctx.options.store.updateGroup(name, change);
		this.#ctx.retitle(group);
		this.#ctx.changed();
		return `Updated the group "${group.displayName}": members ${group.members.join(", ")}; host ${group.host}.`;
	}
}
