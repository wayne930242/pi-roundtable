import {
	CharacterError,
	type CharacterInput,
	type CharacterSpec,
	resolveCharacter,
	suggestCharacter,
} from "../../characters/index.ts";
import { AgentError } from "../domain/errors.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import { addressee } from "../speakers.ts";
import { openingTaskText } from "./agent-prompt.ts";
import { characterOf, overBase } from "./agent-rules.ts";
import { modelSetting, thinkingSetting } from "./agent-settings.ts";
import type { Agent } from "./agent-store.ts";
import { discordKey, keysOf } from "./team-keys.ts";
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
			/** @deprecated Ignored: agents are composed characters. */
			avatarPrompt?: string;
			/** Fields of its look; any left out come from the look its role suggests. */
			character?: CharacterInput;
			task: string;
			category?: string;
			skills?: string[];
		},
	): Promise<string> {
		const { store, studio, channels, queue, skills, surfaces, logger } =
			this.#ctx.options;
		if (input.skills && input.skills.length > 0 && !skills)
			throw new AgentError(
				"Skills are off on this host, so an agent cannot carry any. Create it without skills.",
			);
		const speaker = this.#ctx.turns.speakerOf(caller);
		if (!speaker)
			throw new AgentError(
				"agent_create can only be used during an agent turn.",
			);
		const {
			category,
			skills: carried = [],
			character: wanted,
			avatarPrompt: _ignored,
			...fields
		} = input;
		const parent = teamCategory(category, "Agents");
		store.checkNewName(input.name);
		skills?.checkRegistered(carried);
		// The picture comes before the row and the channel: a render failure fails the create.
		const taken = store
			.agents()
			.flatMap((other) =>
				other.status === "active" && other.character ? [other.character] : [],
			);
		const suggested = suggestCharacter(input, taken);
		const character = this.#resolve(wanted ?? {}, suggested);
		const avatarHash = await studio.render(character);
		// Without Discord channels the agent lives in its rooms, which exist as soon as it does.
		const channelId = await channels?.createChannel(
			input.name,
			input.displayName,
			parent,
		);
		const agent = await store.createAgent({
			...fields,
			character,
			avatarHash,
			...(channelId ? { channelId } : {}),
		});
		if (skills && carried.length > 0)
			await skills.attach(agent.name, carried, []);
		logger.info(
			{ agent: agent.name, by: caller.name, class: character.class },
			"agent created",
		);
		this.#ctx.changed();
		const avatar = `its picture is the ${character.class} look`;
		// The opening task runs where the agent is first reached: its channel, else its first room.
		const home = channelId
			? discordKey(channelId)
			: keysOf(store, agent.name, surfaces?.roomSurfaces() ?? [])[0];
		const creator = store.agent(caller.name);
		const where = channelId ? ` in <#${channelId}>` : "";
		if (!home) {
			logger.warn(
				{ agent: agent.name },
				"opening turn skipped: the agent has no channel or room",
			);
			return `Created "${agent.displayName}" (${agent.name})${where}; ${avatar}. It has no room to start its opening task in yet.`;
		}
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
		return `Created "${agent.displayName}" (${agent.name})${where}; ${avatar}. It is starting on its opening task now.`;
	}

	/** The agent tool: changes a look, then says what the owner sees. */
	async avatar(name: string, look: CharacterInput): Promise<string> {
		const agent = await this.dress(name, look);
		return `"${agent.displayName}" now looks like a ${characterOf(agent).class}; the new picture shows from its next message.`;
	}

	/**
	 * Changes an agent's look. The input is resolved over the agent's current character; a new
	 * class keeps the agent's colors unless the input names a palette or colors. The picture is
	 * rendered before anything is stored, and the character and picture are stored together.
	 */
	async dress(name: string, input: CharacterInput): Promise<Agent> {
		const { store, studio, logger } = this.#ctx.options;
		const agent = store.activeAgent(name);
		const base = characterOf(agent);
		const character = this.#resolve(input, base);
		let avatarHash: string;
		try {
			avatarHash = await studio.render(character);
		} catch (error) {
			throw new AgentError(
				`The picture could not be rendered: ${error instanceof Error ? error.message : String(error)}. The previous look stays.`,
			);
		}
		const dressed = await store.updateAgent(name, { character, avatarHash });
		logger.info({ agent: name, class: character.class }, "agent dressed");
		this.#ctx.changed();
		return dressed;
	}

	/**
	 * An input over a base look (see overBase); a bad field is an AgentError that names it.
	 */
	#resolve(input: CharacterInput, base: CharacterSpec): CharacterSpec {
		try {
			return resolveCharacter(overBase(input, base), base);
		} catch (error) {
			if (error instanceof CharacterError)
				throw new AgentError(`The look is not usable: ${error.message}.`);
			throw error;
		}
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
		const topic = groupTopic({ ...fields, host, status: "active" }, store);
		const channelId = await channels?.createChannel(input.name, topic, parent);
		const group = await store.createGroup({
			...fields,
			host,
			...(channelId ? { channelId } : {}),
		});
		logger.info({ group: group.name, members: group.members }, "group created");
		this.#ctx.changed();
		return `Created the group "${group.displayName}"${channelId ? ` in <#${channelId}>` : ""} with ${group.members.join(", ")}; host ${group.host}.`;
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
