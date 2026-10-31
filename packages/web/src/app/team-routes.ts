import type {
	AgentChange,
	AgentDirectory,
	AgentTeam,
	ChannelKey,
	ConversationModes,
	Speaker,
} from "pi-roundtable";
import { agentRoomKey, characterOf, groupRoomKey } from "pi-roundtable";
import { resolveCharacter, suggestCharacter } from "pi-roundtable/characters";
import type {
	AgentCreate,
	AgentPatch,
	AgentProfileView,
	AgentSkillsChange,
	AgentSkillsView,
	ArchivedEntry,
	ArchiveView,
	CharacterRequest,
	GroupCreate,
	GroupPatch,
	GroupProfileView,
	PromptHistoryView,
	SkillView,
} from "../api-types.ts";
import { json } from "../http.ts";
import type { PushMutes } from "../push/mutes.ts";
import {
	bad,
	bodyOf,
	HttpError,
	notFound,
	optionalList,
	optionalText,
	requiredText,
} from "./api-http.ts";
import type { CardLog } from "./card-log.ts";
import type { LayoutStore } from "./layout.ts";
import { promptVersionView } from "./prompt-routes.ts";
import type { RoomLog } from "./room-log.ts";
import type { Rooms } from "./rooms.ts";
import type { WebThreads } from "./threads.ts";

/** The largest body of a character write: 4 KiB. */
const MAX_CHARACTER_BYTES = 4 * 1024;

export interface TeamApiOptions {
	/** The key prefix of the app's rooms, such as `app`. */
	surface: string;
	rooms: Pick<Rooms, "avatarOf">;
	directory: Pick<AgentDirectory, "agent" | "agents" | "group" | "groups">;
	team: Pick<
		AgentTeam,
		| "update"
		| "promptHistory"
		| "dress"
		| "modelOf"
		| "createAgent"
		| "archive"
		| "restore"
		| "remove"
		| "createGroup"
		| "updateGroup"
	>;
	skills?:
		| {
				catalog(): SkillView[];
				attach(
					agent: string,
					add: readonly string[],
					remove: readonly string[],
				): Promise<string[]>;
		  }
		| undefined;
	/** What a deleted agent's or group's room leaves behind in the app. */
	log: Pick<RoomLog, "removeRoom">;
	cards: Pick<CardLog, "removeRoom">;
	mutes: Pick<PushMutes, "set">;
	modes: Pick<ConversationModes, "forget">;
	/** The dispatch threads under a room, which go with it. */
	threads: Pick<WebThreads, "under" | "removeUnder">;
	/** The owners' shared arrangement, which drops a deleted room's pin and folder place. */
	layout: Pick<LayoutStore, "forget">;
	changed(): void;
}

/** The owner who writes: their tier read again. */
export type OwnerOf = () => Promise<Speaker>;

/**
 * The app's REST for the team: reading and editing an agent, making one, archiving, restoring and
 * deleting agents and groups, an agent's skills, and the groups. Everything goes through the agent
 * server's own operations (`AgentTeam`), so an agent made here is the one `agent_create` makes and
 * an archived one the one `archive` leaves; this class only checks the request and words the answer.
 */
export class TeamApi {
	readonly #options: TeamApiOptions;

	constructor(options: TeamApiOptions) {
		this.#options = options;
	}

	// ── Agents ─────────────────────────────────────────────────────────────

	async agents(
		request: Request,
		parts: string[],
		owner: OwnerOf,
	): Promise<Response> {
		const { method } = request;
		const [, , name, action] = parts;
		const { directory } = this.#options;
		// The owner check comes first, so no answer tells a member which names and states exist.
		// An agent's profile is the one read open to a member.
		const speaker =
			method === "GET" && name && !action ? undefined : await owner();
		const asOwner: OwnerOf = async () => speaker ?? owner();
		if (!name) {
			if (method !== "POST") throw new HttpError(405, "Method not allowed.");
			return this.#createAgent(request, asOwner);
		}
		const agent = directory.agent(name);
		if (!agent) throw notFound();
		const active = agent.status === "active";
		if (action === "restore" && method === "POST" && parts.length === 4) {
			if (active) throw bad(`"${name}" is not archived.`);
			await this.#options.team.restore(name);
			this.#options.changed();
			return json(this.#profile(name));
		}
		if (!action && method === "DELETE") {
			const by = await asOwner();
			// The app's part runs inside the delete, after its checks and before the row goes: a
			// cleanup that fails leaves the agent there to delete again.
			const room = agentRoomKey(this.#options.surface, name);
			await this.#options.team.remove(name, async () => {
				// Its archived temp knights go with it, and so does what the app kept of their rooms.
				for (const helper of this.#options.directory
					.agents()
					.filter((one) => one.parent === name))
					await this.#forget(
						agentRoomKey(this.#options.surface, helper.name),
						by,
					);
				await this.#forget(room, by);
			});
			this.#options.changed();
			return json({ ok: true });
		}
		// Everything else is about an agent that answers.
		if (!active) throw notFound();
		if (!action && method === "GET") return json(this.#profile(name));
		if (!action && method === "PATCH")
			return this.#patch(request, name, asOwner);
		if (action === "prompt-history" && method === "GET" && parts.length === 4) {
			await asOwner();
			return json({
				versions: (await this.#options.team.promptHistory(name)).map(
					promptVersionView,
				),
			} satisfies PromptHistoryView);
		}
		if (action === "character" && method === "PUT")
			return this.#dress(request, name, asOwner);
		if (action === "archive" && method === "POST" && parts.length === 4) {
			await this.#options.team.archive(undefined, name);
			this.#options.changed();
			return json({ ok: true });
		}
		if (action === "skills" && parts.length === 4) {
			if (method === "GET") return json(this.#skillsOf(name));
			if (method === "PUT") return this.#carry(request, name, asOwner);
		}
		throw new HttpError(404, "There is no such API.");
	}

	async #createAgent(request: Request, owner: OwnerOf): Promise<Response> {
		const speaker = await owner();
		const body = await bodyOf(request);
		const name = requiredText(body, "name");
		const displayName = requiredText(body, "displayName");
		const prompt = requiredText(body, "prompt");
		const model = optionalText(body, "model");
		const thinking = optionalText(body, "thinking");
		const task = optionalText(body, "task")?.trim();
		const skills = optionalList(body, "skills");
		const { character } = body;
		if (
			character !== undefined &&
			(typeof character !== "object" ||
				character === null ||
				Array.isArray(character))
		)
			throw bad("character must be an object.");
		const made: AgentCreate = {
			name,
			displayName,
			prompt,
			...(model !== undefined ? { model } : {}),
			...(thinking !== undefined ? { thinking } : {}),
			...(task ? { task } : {}),
			...(skills && skills.length > 0 ? { skills } : {}),
			...(character !== undefined
				? { character: character as NonNullable<AgentCreate["character"]> }
				: {}),
		};
		// `createAgent` words a refusal of the look as an agent error; checking here first names the field.
		if (made.character)
			resolveCharacter(
				made.character,
				suggestCharacter({ name, displayName, prompt }),
			);
		// The opening task starts in the app's room for the agent, where the owner is looking.
		await this.#options.team.createAgent(speaker, {
			...made,
			openIn: this.#options.surface,
		});
		this.#options.changed();
		return json(this.#profile(name), 201);
	}

	async #patch(
		request: Request,
		name: string,
		owner: OwnerOf,
	): Promise<Response> {
		const speaker = await owner();
		const body = await bodyOf(request);
		const patch: AgentPatch = {};
		for (const key of ["displayName", "prompt", "model", "thinking"] as const) {
			const value = optionalText(body, key);
			if (value !== undefined) patch[key] = value;
		}
		const change: AgentChange = patch;
		// A changed prompt is kept in the agent's history under the owner's name.
		await this.#options.team.update(name, change, speaker.name);
		this.#options.changed();
		return json(this.#profile(name));
	}

	async #dress(
		request: Request,
		name: string,
		owner: OwnerOf,
	): Promise<Response> {
		await owner();
		const body = await bodyOf(request, MAX_CHARACTER_BYTES);
		const { character } = body;
		if (
			typeof character !== "object" ||
			character === null ||
			Array.isArray(character)
		)
			throw bad("character must be an object.");
		const asked: CharacterRequest = {
			character: character as CharacterRequest["character"],
		};
		const agent = this.#options.directory.agent(name);
		if (!agent) throw notFound();
		// `dress` words a refusal as an agent error; checking here first names the field.
		resolveCharacter(asked.character, characterOf(agent));
		await this.#options.team.dress(name, asked.character);
		this.#options.changed();
		return json(this.#profile(name));
	}

	/** Every skill of the host's catalog, and whether this agent carries it. */
	#skillsOf(name: string): AgentSkillsView {
		const { skills } = this.#options;
		if (!skills) throw new HttpError(404, "This host has no skills.");
		return {
			skills: skills.catalog().map((entry) => {
				const builtin = entry.source.kind === "builtin";
				return {
					name: entry.name,
					...(entry.description ? { description: entry.description } : {}),
					source: entry.source.kind,
					builtin,
					carried: builtin || entry.carriers.includes(name),
					...(entry.missing ? { missing: entry.missing } : {}),
				};
			}),
		};
	}

	async #carry(
		request: Request,
		name: string,
		owner: OwnerOf,
	): Promise<Response> {
		const { skills } = this.#options;
		if (!skills) throw new HttpError(404, "This host has no skills.");
		await owner();
		const body = await bodyOf(request);
		const add = optionalList(body, "add") ?? [];
		const remove = optionalList(body, "remove") ?? [];
		const change: AgentSkillsChange = { add, remove };
		if (add.length === 0 && remove.length === 0)
			throw bad("Give add or remove.");
		// One call, so an unknown or built-in name refuses the whole change.
		await skills.attach(name, change.add ?? [], change.remove ?? []);
		this.#options.changed();
		return json(this.#skillsOf(name));
	}

	#profile(name: string): AgentProfileView {
		const { directory, team, rooms, surface } = this.#options;
		const agent = directory.agent(name);
		if (!agent) throw notFound();
		const effective = team.modelOf(name);
		return {
			name: agent.name,
			displayName: agent.displayName,
			prompt: agent.prompt,
			...(agent.model ? { model: agent.model } : {}),
			...(agent.thinking ? { thinking: agent.thinking } : {}),
			effective: {
				model: effective.model,
				thinking: String(effective.thinking),
			},
			avatar: rooms.avatarOf(agent),
			character: characterOf(agent),
			room: agentRoomKey(surface, agent.name),
			...(agent.parent
				? {
						helper: {
							parent: agentRoomKey(surface, agent.parent),
							parentName:
								directory.agent(agent.parent)?.displayName ?? agent.parent,
						},
					}
				: {}),
		};
	}

	// ── Groups ─────────────────────────────────────────────────────────────

	async groups(
		request: Request,
		parts: string[],
		owner: OwnerOf,
	): Promise<Response> {
		const { method } = request;
		const [, , name, action] = parts;
		const { directory, team } = this.#options;
		// The owner check comes first, so no answer tells a member which names and states exist.
		const speaker = await owner();
		if (!name) {
			if (method !== "POST") throw new HttpError(405, "Method not allowed.");
			const body = await bodyOf(request);
			const members = optionalList(body, "members");
			if (!members) throw bad("members must be a list of text.");
			const host = optionalText(body, "host");
			const made: GroupCreate = {
				name: requiredText(body, "name"),
				displayName: requiredText(body, "displayName"),
				members,
				...(host !== undefined ? { host } : {}),
			};
			await team.createGroup(made);
			this.#options.changed();
			return json(this.#group(made.name), 201);
		}
		const group = directory.group(name);
		if (!group) throw notFound();
		const active = group.status === "active";
		if (action === "restore" && method === "POST" && parts.length === 4) {
			if (active) throw bad(`"${name}" is not archived.`);
			await team.restore(name);
			this.#options.changed();
			return json(this.#group(name));
		}
		if (!action && method === "DELETE") {
			const room = groupRoomKey(this.#options.surface, name);
			await team.remove(name, () => this.#forget(room, speaker));
			this.#options.changed();
			return json({ ok: true });
		}
		if (!active) throw notFound();
		if (!action && method === "GET") return json(this.#group(name));
		if (!action && method === "PATCH") {
			const body = await bodyOf(request);
			const displayName = optionalText(body, "displayName");
			const members = optionalList(body, "members");
			const host = optionalText(body, "host");
			const patch: GroupPatch = {
				...(displayName !== undefined ? { displayName } : {}),
				...(members !== undefined ? { members } : {}),
				...(host !== undefined ? { host } : {}),
			};
			if (Object.keys(patch).length === 0)
				throw bad("Give displayName, members or host.");
			await team.updateGroup(name, patch);
			this.#options.changed();
			return json(this.#group(name));
		}
		if (action === "archive" && method === "POST" && parts.length === 4) {
			await team.archive(undefined, name);
			this.#options.changed();
			return json({ ok: true });
		}
		throw new HttpError(404, "There is no such API.");
	}

	#group(name: string): GroupProfileView {
		const group = this.#options.directory.group(name);
		if (!group) throw notFound();
		return {
			name: group.name,
			displayName: group.displayName,
			members: [...group.members],
			host: group.host,
			room: groupRoomKey(this.#options.surface, group.name),
		};
	}

	// ── The archive ────────────────────────────────────────────────────────

	/** Archived agents and groups, which stay reachable here until they are restored or deleted. */
	async archived(owner: OwnerOf): Promise<Response> {
		await owner();
		const { directory, rooms } = this.#options;
		const entries: ArchivedEntry[] = [
			...directory
				.agents()
				.filter((agent) => agent.status === "archived")
				.map(
					(agent): ArchivedEntry => ({
						kind: "agent",
						name: agent.name,
						displayName: agent.displayName,
						avatar: rooms.avatarOf(agent),
						character: characterOf(agent),
						...(agent.parent ? { parent: agent.parent } : {}),
					}),
				),
			...directory
				.groups()
				.filter((group) => group.status === "archived")
				.map(
					(group): ArchivedEntry => ({
						kind: "group",
						name: group.name,
						displayName: group.displayName,
						members: [...group.members],
					}),
				),
		].sort((a, b) => a.name.localeCompare(b.name));
		return json({ entries } satisfies ArchiveView);
	}

	/**
	 * What the app kept of a room that is gone for good: its messages, cards, mute, and pin or
	 * folder place, and its dispatch threads with theirs. It can run again after a failure: the threads go last, so
	 * until then the retry still finds them.
	 */
	async #forget(room: string, by: Speaker): Promise<void> {
		const { log, cards, mutes, modes, threads, layout, surface } =
			this.#options;
		for (const thread of await threads.under(room)) {
			const threadRoom = `${surface}:${thread.id}`;
			await log.removeRoom(threadRoom);
			await cards.removeRoom(threadRoom);
		}
		await threads.removeUnder(room);
		await log.removeRoom(room);
		await cards.removeRoom(room);
		await mutes.set(room, false, by.principalId);
		await layout.forget(room);
		// A name made again later starts with the modes of a new room, and follows nothing.
		await modes.forget(room as ChannelKey);
	}
}
