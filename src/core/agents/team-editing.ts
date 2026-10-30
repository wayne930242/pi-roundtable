import {
	CharacterError,
	type CharacterInput,
	type CharacterSpec,
	resolveCharacter,
	suggestCharacter,
} from "../../characters/index.ts";
import { parseChannelKey } from "../contract/surface.ts";
import { AgentError } from "../domain/errors.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import { SYSTEM_PRINCIPAL } from "../identity/principal-store.ts";
import type { ConversationModes } from "../modes/conversation-modes.ts";
import type { AgentChange } from "../services.ts";
import { addressee, type Speaker } from "../speakers.ts";
import { openingTaskText } from "./agent-prompt.ts";
import { characterOf, overBase } from "./agent-rules.ts";
import { modelSetting, thinkingSetting } from "./agent-settings.ts";
import type { Agent } from "./agent-store.ts";
import type { AvatarMode } from "./agent-tools.ts";
import { routesOf } from "./routes.ts";
import { agentRoomKey, keysOf, seatsOf } from "./team-keys.ts";
import { groupTopic, teamCategory } from "./team-layout.ts";
import type { TeamContext } from "./team-options.ts";

/** Said when an avatar is to be redrawn on a host without an image provider. */
const NO_IMAGE_PROVIDER =
	"No image provider is configured, so avatars cannot be redrawn; the current picture stays. A plugin fills the images slot to draw them.";

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
		change: AgentChange,
		by?: string,
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
		const agent = await store.updateAgent(
			name,
			{
				...(change.displayName !== undefined
					? { displayName: change.displayName }
					: {}),
				...(change.prompt !== undefined ? { prompt: change.prompt } : {}),
				...(model !== undefined ? { model } : {}),
				...(thinking !== undefined ? { thinking } : {}),
			},
			by,
		);
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

	/** The agent tool: an agent creates another, which starts on the opening task at once. */
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
			/** Turn long-running mode on for its conversations; the speaker must be an owner. */
			longRunning?: boolean;
		},
	): Promise<string> {
		this.#refuseSkillsOff(input.skills);
		const speaker = this.#ctx.turns.speakerOf(caller);
		if (!speaker)
			throw new AgentError(
				"agent_create can only be used during an agent turn.",
			);
		// The opening task starts on the surface the caller's turn runs on, as the web form's does.
		const working = this.#ctx.turns.workingIn(caller.name);
		const made = await this.#create(
			{
				speaker,
				by: caller.name,
				creator: this.#ctx.options.store.agent(caller.name),
				openIn: working ? parseChannelKey(working).surface : undefined,
			},
			input,
		);
		return made.text;
	}

	/**
	 * An owner creates an agent from outside any agent turn (the web app's form; any other tier is
	 * refused, since the opening task runs as `speaker`): the same checks,
	 * picture, channel and opening task as `create`, and the model and thinking level the owner
	 * picked. Without a task the agent only exists, waiting in its room. Returns the new agent.
	 */
	async createFor(
		speaker: Speaker,
		input: {
			name: string;
			displayName: string;
			prompt: string;
			character?: CharacterInput;
			task?: string;
			openIn?: string;
			category?: string;
			skills?: string[];
			model?: string;
			thinking?: string;
		},
	): Promise<Agent> {
		if (speaker.tier !== "owner")
			throw new AgentError("Only an owner may create an agent here.");
		const { model, thinking, task, openIn, ...rest } = input;
		const made = await this.#create(
			{ speaker, by: speaker.name, creator: undefined, openIn },
			{ ...rest, ...(task ? { task } : {}) },
			{ model, thinking },
		);
		return made.agent;
	}

	/**
	 * The modes to turn long-running on in, once the speaker may: an owner other than the host's
	 * own turns, as for any change of a conversation's modes. Refused before anything is made.
	 */
	#longRunning(speaker: Speaker): ConversationModes {
		const modes = this.#ctx.options.modes?.();
		if (!modes)
			throw new AgentError(
				"This host has no conversation modes, so long_running cannot be set. Create the agent without it.",
			);
		if (speaker.tier !== "owner" || speaker.principalId === SYSTEM_PRINCIPAL)
			throw new AgentError(
				"Only an owner's turn may create an agent with long_running on. Create it without, and ask the owner to turn it on.",
			);
		return modes;
	}

	/** An agent cannot carry skills on a host with skills switched off. */
	#refuseSkillsOff(carried: string[] | undefined): void {
		if (carried && carried.length > 0 && !this.#ctx.options.skills)
			throw new AgentError(
				"Skills are off on this host, so an agent cannot carry any. Create it without skills.",
			);
	}

	async #create(
		who: {
			speaker: Speaker;
			by: string;
			creator: Agent | undefined;
			/** The surface whose room runs the opening task. */
			openIn?: string | undefined;
		},
		input: {
			name: string;
			displayName: string;
			prompt: string;
			/** @deprecated Ignored: agents are composed characters. */
			avatarPrompt?: string;
			character?: CharacterInput;
			task?: string;
			category?: string;
			skills?: string[];
			longRunning?: boolean;
		},
		settings: {
			model?: string | undefined;
			thinking?: string | undefined;
		} = {},
	): Promise<{ agent: Agent; text: string }> {
		const { store, studio, channels, queue, skills, surfaces, logger } =
			this.#ctx.options;
		this.#refuseSkillsOff(input.skills);
		const {
			category,
			skills: carried = [],
			character: wanted,
			avatarPrompt: _ignored,
			task,
			longRunning,
			...fields
		} = input;
		const modes = longRunning ? this.#longRunning(who.speaker) : undefined;
		const parent = teamCategory(category, "Agents");
		store.checkNewName(input.name);
		skills?.checkRegistered(carried);
		// A model or thinking level the host cannot run fails the create, before anything is made.
		const model = await modelSetting(settings.model, () =>
			this.#ctx.options.models.usable(),
		);
		const thinking = thinkingSetting(settings.thinking);
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
		let agent = await store.createAgent({
			...fields,
			character,
			avatarHash,
			...(channelId ? { channelId } : {}),
		});
		if (model || thinking)
			agent = await store.updateAgent(agent.name, {
				...(model ? { model } : {}),
				...(thinking ? { thinking } : {}),
			});
		if (skills && carried.length > 0)
			await skills.attach(agent.name, carried, []);
		logger.info(
			{ agent: agent.name, by: who.by, class: character.class },
			"agent created",
		);
		this.#ctx.changed();
		const rooms = surfaces?.roomSurfaces() ?? [];
		// Before the opening task starts, so its turn already runs under the mode.
		if (modes)
			for (const key of keysOf(store, agent.name, rooms))
				await modes.set(key, { longRunning: true }, who.speaker);
		const avatar = `its picture is the ${character.class} look${modes ? "; long-running mode is on" : ""}`;
		const where = channelId ? ` in <#${channelId}>` : "";
		if (!task)
			return {
				agent,
				text: `Created "${agent.displayName}" (${agent.name})${where}; ${avatar}.`,
			};
		// The opening task runs where the routing table puts it: by default the agent's place on the
		// surface that asked, else its primary place.
		const home = routesOf(this.#ctx.options).of(
			agent.name,
			"opening",
			who.openIn === undefined
				? undefined
				: agentRoomKey(who.openIn, agent.name),
		);
		if (!home) {
			logger.warn(
				{ agent: agent.name },
				"opening turn skipped: the agent has no channel or room",
			);
			return {
				agent,
				text: `Created "${agent.displayName}" (${agent.name})${where}; ${avatar}. It has no room to start its opening task in yet.`,
			};
		}
		void queue
			.run(home, () =>
				this.#ctx.turns.answerBackground(
					home,
					who.speaker,
					openingTaskText(
						who.creator,
						task,
						addressee(who.speaker, this.#ctx.options.owner),
					),
				),
			)
			.catch((error: unknown) =>
				logger.error({ agent: agent.name, err: error }, "opening turn failed"),
			);
		return {
			agent,
			text: `Created "${agent.displayName}" (${agent.name})${where}; ${avatar}. It is starting on its opening task now.`,
		};
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

	/** @deprecated Use `dress`; removed in 1.0. Draws and stores a new picture. */
	async redrawAvatar(
		name: string,
		mode: AvatarMode,
		text?: string,
	): Promise<Agent> {
		const { store, studio, logger } = this.#ctx.options;
		const agent = store.activeAgent(name);
		if (studio.canDraw === false) throw new AgentError(NO_IMAGE_PROVIDER);
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
		store.checkNewGroup(input.name, input.members, host, input.displayName);
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
		const { store, surfaces } = this.#ctx.options;
		const before = store.group(name);
		const group = await store.updateGroup(name, change);
		// A member taken out starts its seat over, so an agent of that name that joins later
		// does not resume the old conversation.
		const runtime = this.#ctx.options.runtime();
		const rooms = surfaces?.roomSurfaces() ?? [];
		for (const left of before?.members ?? [])
			if (!group.members.includes(left))
				for (const seat of seatsOf(group, left, rooms))
					await runtime.startFresh(seat);
		this.#ctx.retitle(group);
		this.#ctx.changed();
		return `Updated the group "${group.displayName}": members ${group.members.join(", ")}; host ${group.host}.`;
	}
}
