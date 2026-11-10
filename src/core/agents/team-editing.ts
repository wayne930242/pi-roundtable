import {
	type CharacterInput,
	suggestCharacter,
} from "../../characters/index.ts";
import { parseChannelKey } from "../contract/surface.ts";
import { AgentError } from "../domain/errors.ts";
import type { AgentTurnScope } from "../domain/ports.ts";
import { SYSTEM_PRINCIPAL } from "../identity/principal-store.ts";
import { addressee, type Speaker } from "../identity/speakers.ts";
import type { ConversationModes } from "../modes/conversation-modes.ts";
import type { AgentChange, NewAgent } from "../plugin-api/services.ts";
import { openingTaskText } from "./agent-prompt.ts";
import { modelSetting, thinkingSetting } from "./agent-settings.ts";
import type { Agent } from "./agent-store.ts";
import { createHelper } from "./helper-create.ts";
import { routesOf } from "./routes.ts";
import { resolveLook } from "./team-looks.ts";
import type { TeamContext } from "./team-options.ts";
import { type PlaceWish, TeamPlaceWrites } from "./team-place-writes.ts";
import { groupTopic } from "./team-text.ts";

/**
 * What the creating tools and the team's callers give a provider's own arguments: `hints`, with
 * the string fields left over from the known ones, which are the arguments a provider added before
 * `hints` existed (the deprecated `NewAgent.category`). Undefined when there are none.
 */
function providerHints(
	extras: object,
	hints: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
	const legacy = Object.entries(extras).filter(
		(entry): entry is [string, string] => typeof entry[1] === "string",
	);
	const all = { ...Object.fromEntries(legacy), ...hints };
	return Object.keys(all).length > 0 ? all : undefined;
}

/** Creating and changing agents, their avatars, and groups. */
export class TeamEditing {
	readonly #ctx: TeamContext;
	readonly #places: TeamPlaceWrites;

	constructor(ctx: TeamContext) {
		this.#ctx = ctx;
		this.#places = new TeamPlaceWrites(ctx);
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
			/** The values of the arguments the surfaces' place providers add to the creation tool. */
			hints?: Readonly<Record<string, string>>;
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

	#helperChain: Promise<void> = Promise.resolve();

	/** The agent tool: a knight makes a temp knight for one task; see `createHelper`. */
	createHelper(
		caller: AgentTurnScope,
		input: Parameters<typeof createHelper>[3],
	): Promise<string> {
		// One at a time: parallel calls cannot overshoot a cap or pick one name.
		const run = this.#helperChain.then(() =>
			createHelper(
				this.#ctx,
				(who, fields, settings) => this.#create(who, fields, settings),
				caller,
				input,
			),
		);
		this.#helperChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/**
	 * An owner creates an agent from outside any agent turn (the web app's form; any other tier is
	 * refused, since the opening task runs as `speaker`): the checks, picture, channel and opening
	 * task of `create`, and the owner's model and thinking. Without a task it waits in its room.
	 */
	async createFor(speaker: Speaker, input: NewAgent): Promise<Agent> {
		if (speaker.tier !== "owner")
			throw new AgentError("Only an owner may create an agent here.");
		const {
			model,
			thinking,
			task,
			openIn,
			hints,
			name,
			displayName,
			prompt,
			character,
			skills,
			...extras
		} = input;
		const given = providerHints(extras, hints);
		const made = await this.#create(
			{ speaker, by: speaker.name, creator: undefined, openIn },
			{
				name,
				displayName,
				prompt,
				...(character ? { character } : {}),
				...(skills ? { skills } : {}),
				...(task ? { task } : {}),
				...(given ? { hints: given } : {}),
			},
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
			/** Makes the agent a temp knight of this knight, which settles on the parent's model. */
			parent?: Agent | undefined;
			/** The conversation a temp knight is made from: it lives in a thread of the parent's place on that surface, and in its rooms alone where no thread is made. */
			origin?: string | undefined;
			preset?: string | undefined;
		},
		input: {
			name: string;
			displayName: string;
			prompt: string;
			/** @deprecated Ignored: agents are composed characters. */
			avatarPrompt?: string;
			character?: CharacterInput;
			task?: string;
			hints?: Readonly<Record<string, string>>;
			skills?: string[];
			longRunning?: boolean;
		},
		settings: {
			model?: string | undefined;
			thinking?: string | undefined;
		} = {},
	): Promise<{ agent: Agent; text: string }> {
		const { store, studio, queue, skills, places, logger } = this.#ctx.options;
		this.#refuseSkillsOff(input.skills);
		const {
			hints,
			skills: carried = [],
			character: wanted,
			avatarPrompt: _ignored,
			task,
			longRunning,
			...fields
		} = input;
		const modes = longRunning ? this.#longRunning(who.speaker) : undefined;
		store.checkNewName(input.name);
		skills?.checkRegistered(carried);
		// An unusable model or thinking fails the create first; a temp knight runs its parent's unless told otherwise.
		const model =
			settings.model === undefined && who.parent
				? who.parent.model
				: await modelSetting(settings.model, () =>
						this.#ctx.options.models.usable(),
					);
		const thinking =
			settings.thinking === undefined && who.parent
				? who.parent.thinking
				: thinkingSetting(settings.thinking);
		// The picture comes before the row and the place: a render failure fails the create.
		const taken = store
			.agents()
			.flatMap((other) =>
				other.status === "active" && other.character ? [other.character] : [],
			);
		const suggested = suggestCharacter(input, taken);
		const character = resolveLook(wanted ?? {}, suggested);
		const avatarHash = await studio.render(character);
		// Without stored places the agent lives in its rooms, which exist as soon as it does.
		const wish: PlaceWish = {
			kind: "agent",
			name: input.name,
			displayName: input.displayName,
			topic: input.displayName,
			...(hints ? { hints } : {}),
		};
		const made = await this.#places.make(
			wish,
			who.parent ? { parent: who.parent, origin: who.origin } : undefined,
		);
		let agent: Agent;
		try {
			agent = await store.createAgent({
				...fields,
				character,
				avatarHash,
				...(who.parent ? { parent: who.parent.name } : {}),
				...(who.parent && who.origin ? { origin: who.origin } : {}),
				...(who.parent && who.preset ? { preset: who.preset } : {}),
			});
			await this.#places.record(wish, made);
		} catch (error) {
			if (who.parent) await this.#places.discard(wish, made);
			throw error;
		}
		try {
			if (model || thinking)
				agent = await store.updateAgent(agent.name, {
					...(model ? { model } : {}),
					...(thinking ? { thinking } : {}),
				});
			if (skills && carried.length > 0)
				await skills.attach(agent.name, carried, []);
		} catch (error) {
			if (who.parent) await this.#ctx.archiveHelpers([agent.name]);
			throw error;
		}
		logger.info(
			{ agent: agent.name, by: who.by, class: character.class },
			"agent created",
		);
		this.#ctx.changed();
		// Before the opening task starts, so its turn already runs under the mode.
		if (modes)
			for (const key of places.keysOf(agent.name))
				await modes.set(key, { longRunning: true }, who.speaker);
		const avatar = `its picture is the ${character.class} look${modes ? "; long-running mode is on" : ""}`;
		const where =
			made.length > 0 ? ` in ${this.#places.mentions(wish, made)}` : "";
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
				: places.placeOn(agent.name, who.openIn),
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

	async createGroup(input: {
		name: string;
		displayName: string;
		members: string[];
		host?: string;
		hints?: Readonly<Record<string, string>>;
	}): Promise<string> {
		const { store, logger } = this.#ctx.options;
		const {
			name,
			displayName,
			members,
			host: named,
			hints: given,
			...extras
		} = input;
		const hints = providerHints(extras, given);
		const fields = {
			name,
			displayName,
			members,
			...(named ? { host: named } : {}),
		};
		const host =
			input.host ??
			(input.members.includes("coordinator")
				? "coordinator"
				: (input.members[0] ?? ""));
		store.checkNewGroup(input.name, input.members, host, input.displayName);
		const wish: PlaceWish = {
			kind: "group",
			name: input.name,
			displayName: input.displayName,
			topic: groupTopic({ ...fields, host, status: "active" }, store),
			...(hints ? { hints } : {}),
		};
		const made = await this.#places.make(wish);
		const group = await store.createGroup({ ...fields, host });
		await this.#places.record(wish, made);
		logger.info({ group: group.name, members: group.members }, "group created");
		this.#ctx.changed();
		return `Created the group "${group.displayName}"${made.length > 0 ? ` in ${this.#places.mentions(wish, made)}` : ""} with ${group.members.join(", ")}; host ${group.host}.`;
	}

	async updateGroup(
		name: string,
		change: { displayName?: string; members?: string[]; host?: string },
	): Promise<string> {
		const { store, places } = this.#ctx.options;
		const before = store.group(name);
		const group = await store.updateGroup(name, change);
		// A member taken out starts its seat over, so an agent of that name that joins later
		// does not resume the old conversation.
		const runtime = this.#ctx.options.runtime();
		for (const left of before?.members ?? [])
			if (!group.members.includes(left))
				for (const seat of places.seatsOf(group, left))
					await runtime.startFresh(seat);
		this.#ctx.retitle(group);
		this.#ctx.changed();
		return `Updated the group "${group.displayName}": members ${group.members.join(", ")}; host ${group.host}.`;
	}
}
