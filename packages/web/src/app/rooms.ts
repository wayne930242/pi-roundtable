import type {
	Agent,
	AgentDirectory,
	AgentGroup,
	AgentTeam,
	AvatarStudio,
	ChannelKey,
	ConversationModes,
} from "pi-roundtable";
import {
	agentRoomKey,
	channelKey,
	characterOf,
	groupRoomKey,
	roomOf,
} from "pi-roundtable";
import type { RoomKind, RoomView } from "../api-types.ts";
import type { PushMutes } from "../push/mutes.ts";
import type { RoomLog } from "./room-log.ts";
import type { WebThreads } from "./threads.ts";

/** A room of the app that exists: what it is, and what it is called. */
export interface ResolvedRoom {
	key: ChannelKey;
	kind: RoomKind;
	/** The agent's or group's name; a thread's `thread.<uuid>`. */
	name: string;
	displayName: string;
	/** A thread's room is read only. */
	readOnly: boolean;
}

export interface RoomsOptions {
	surface: string;
	/** The mount, whose `avatars/` serves the pictures. */
	mount: string;
	directory: Pick<AgentDirectory, "agents" | "agent" | "groups" | "group">;
	team: Pick<AgentTeam, "coordinator">;
	avatars: Pick<AvatarStudio, "url">;
	threads: Pick<WebThreads, "get" | "list">;
	log: Pick<RoomLog, "lastOf">;
	modes: Pick<ConversationModes, "peek">;
	/** The rooms whose owners muted push. */
	mutes: Pick<PushMutes, "all">;
	activity(
		room: ChannelKey,
	): Pick<RoomView, "typing" | "stoppable" | "phase" | "agent" | "round">;
	/**
	 * Whether more than one person reads the agent and group rooms, so a message may be an
	 * internal note. Absent: one person does, and a room takes only turns.
	 */
	readers?(): Promise<boolean>;
}

const THREAD_ID = /^thread\.[0-9a-f-]{36}$/;

/**
 * The rooms of the app: Home (the coordinator's), one per active agent, one per active group,
 * and the dispatch threads: the open ones and the latest closed ones. A key a client names is a room only when it is one of these on
 * this surface, whose agent or group exists; no other surface's key ever is.
 */
export class Rooms {
	readonly #options: RoomsOptions;

	constructor(options: RoomsOptions) {
		this.#options = options;
	}

	/** Whether the key is on this surface, whatever it names. */
	ownsKey(key: string): boolean {
		return key.startsWith(`${this.#options.surface}:`);
	}

	/** The room a key names, or undefined when it is none of the app's. */
	async resolve(key: string): Promise<ResolvedRoom | undefined> {
		if (!this.ownsKey(key)) return undefined;
		const { surface, directory, threads } = this.#options;
		const room = key as ChannelKey;
		const named = roomOf(room, [surface]);
		if (named?.kind === "agent") {
			const agent = directory.agent(named.name);
			return agent?.status === "active"
				? {
						key: room,
						kind: "agent",
						name: agent.name,
						displayName: agent.displayName,
						readOnly: false,
					}
				: undefined;
		}
		if (named?.kind === "group") {
			const group = directory.group(named.name);
			return group?.status === "active"
				? {
						key: room,
						kind: "group",
						name: group.name,
						displayName: group.displayName,
						readOnly: false,
					}
				: undefined;
		}
		const id = key.slice(surface.length + 1);
		if (!THREAD_ID.test(id)) return undefined;
		const thread = await threads.get(id);
		// A closed thread stays a room the page can read; nobody can write in it.
		return thread
			? {
					key: room,
					kind: "thread",
					name: thread.id,
					displayName: thread.title,
					readOnly: true,
				}
			: undefined;
	}

	/** Whether the agent and group rooms take internal notes: more than one person reads them. */
	async notesOn(): Promise<boolean> {
		return (await this.#options.readers?.()) === true;
	}

	/** The home room: the coordinator's, else the first active agent's. */
	homeKey(): ChannelKey | undefined {
		const { directory, team, surface } = this.#options;
		const coordinator = team.coordinator();
		const home =
			(coordinator ? directory.agent(coordinator) : undefined) ??
			directory.agents().find((agent) => agent.status === "active");
		return home?.status === "active"
			? agentRoomKey(surface, home.name)
			: undefined;
	}

	/**
	 * The keys of the rooms an owner can pin or put in a folder: the active agents' and groups' rooms,
	 * without Home, which stays at the top, and without threads, which follow their room.
	 */
	placeable(): Set<string> {
		const { surface, directory } = this.#options;
		const home = this.homeKey();
		return new Set<string>(
			[
				...directory
					.agents()
					.filter((agent) => agent.status === "active")
					.map((agent) => agentRoomKey(surface, agent.name)),
				...directory
					.groups()
					.filter((group) => group.status === "active")
					.map((group) => groupRoomKey(surface, group.name)),
			].filter((key) => key !== home),
		);
	}

	/** The agent whose avatar path to show, as a path under the mount. */
	avatarOf(agent: Agent): string {
		// The studio gives a full URL with a public address and a bare path without one.
		const path = /\/avatars\/[^/?#]+$/.exec(
			this.#options.avatars.url(agent.avatarHash),
		)?.[0];
		return `${this.#options.mount}${path ?? "/avatars/missing.png"}`;
	}

	/**
	 * The view of one thread, listed or not: a thread the owners dismissed is off the list and still
	 * opens by its address, and the page asks for its view here.
	 */
	async threadView(key: ChannelKey): Promise<RoomView | undefined> {
		const room = await this.resolve(key);
		if (room?.kind !== "thread") return undefined;
		const thread = await this.#options.threads.get(room.name);
		if (!thread) return undefined;
		const { modes, activity, log } = this.#options;
		const { yolo, longRunning } = modes.peek(key);
		const last = (await log.lastOf([key])).get(key);
		return {
			home: false,
			readOnly: true,
			mode: { yolo, longRunning },
			...activity(key),
			kind: "thread",
			name: thread.id,
			displayName: thread.title,
			parent: thread.parent,
			...(thread.open ? {} : { closed: true as const }),
			...(last ? { last } : {}),
			key,
		};
	}

	async list(): Promise<RoomView[]> {
		const { surface, directory, modes, mutes, activity, log, threads } =
			this.#options;
		const home = this.homeKey();
		const coordinator = this.#options.team.coordinator();
		const agents = directory.agents().filter((a) => a.status === "active");
		const groups = directory.groups().filter((g) => g.status === "active");
		const shown = await threads.list();
		const muted = await mutes.all();
		const notes = await this.notesOn();
		const view = (
			key: ChannelKey,
			rest: Pick<RoomView, "kind" | "name" | "displayName"> & Partial<RoomView>,
		): RoomView => {
			const { yolo, longRunning } = modes.peek(key);
			return {
				home: key === home,
				readOnly: false,
				mode: { yolo, longRunning },
				...(muted.has(key) ? { muted: true as const } : {}),
				...(notes && rest.kind !== "thread" ? { notes: true as const } : {}),
				...activity(key),
				...rest,
				key,
			};
		};
		const rooms: RoomView[] = [
			...agents.map((agent: Agent) =>
				view(agentRoomKey(surface, agent.name), {
					kind: "agent",
					name: agent.name,
					displayName: agent.displayName,
					avatar: this.avatarOf(agent),
					character: characterOf(agent),
					...(agent.name === coordinator ? { coordinator: true as const } : {}),
				}),
			),
			...groups.map((group: AgentGroup) =>
				view(groupRoomKey(surface, group.name), {
					kind: "group",
					name: group.name,
					displayName: group.displayName,
					members: [...group.members],
				}),
			),
			...shown.map((thread) =>
				view(channelKey(surface, thread.id), {
					kind: "thread",
					name: thread.id,
					displayName: thread.title,
					parent: thread.parent,
					readOnly: true,
					...(thread.open ? {} : { closed: true }),
				}),
			),
		];
		// Home first; the others keep the team's order.
		rooms.sort((a, b) => Number(b.home) - Number(a.home));
		const last = await log.lastOf(rooms.map((room) => room.key));
		return rooms.map((room) => {
			const message = last.get(room.key);
			return message ? { ...room, last: message } : room;
		});
	}
}
