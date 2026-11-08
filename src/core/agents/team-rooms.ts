import type {
	RoomGroupsView,
	RoomLayoutService,
} from "../contract/room-layout.ts";
import { AgentError } from "../domain/errors.ts";
import type { AgentDirectory } from "../plugin-api/services.ts";
import { isHelper } from "./agent-rules.ts";

/** The refusal of a room group on a host whose app has no room list. */
export const NO_ROOM_GROUPS =
	"This host has no app room list to group rooms in: groups come with the web app's rooms pane. Leave group out; category places a Discord channel.";

/** What the agent tools do with the app's room groups; `TeamRooms` is the team's. */
export interface RoomOps {
	/** Refuses a group the room could not be placed in, before anything is made. */
	check(group: string): void;
	/** Puts an agent's or group's room into an app group, made when missing; returns text for the model. */
	place(name: string, group: string): Promise<string>;
	/** The app's groups with their rooms, and the pinned rooms; empty when the host has no app room list. */
	listText(): Promise<string>;
	arrange(entries: { group: string; names: string[] }[]): Promise<string>;
}

/** The room groups of the app that hosts the agents' rooms, by agent and group names. */
export class TeamRooms implements RoomOps {
	readonly #store: Pick<AgentDirectory, "agent" | "group">;
	readonly #layout: () => RoomLayoutService | undefined;

	constructor(
		store: Pick<AgentDirectory, "agent" | "group">,
		layout: () => RoomLayoutService | undefined,
	) {
		this.#store = store;
		this.#layout = layout;
	}

	check(group: string): void {
		this.#service();
		if (group.trim() === "") throw new AgentError("Give the group a name.");
	}

	async place(name: string, group: string): Promise<string> {
		this.check(group);
		await provided(() => this.#service().place(name, group.trim()));
		return `Its room is in the app group "${group.trim()}".`;
	}

	async listText(): Promise<string> {
		const service = this.#layout();
		return service ? roomGroupsText(await service.view()) : "";
	}

	/**
	 * Sorts rooms into the app's groups and orders them: the listed groups and rooms first, the
	 * rest where they were. A wrong entry refuses the whole call before anything moves.
	 */
	async arrange(
		entries: { group: string; names: string[] }[],
	): Promise<string> {
		const service = this.#service();
		if (entries.length === 0) throw new AgentError("List at least one group.");
		const groups = new Set<string>();
		const names = new Set<string>();
		const listed = entries.map(({ group, names: rooms }) => {
			const name = group.trim();
			if (name === "") throw new AgentError("Give every group a name.");
			if (groups.has(name.toLocaleLowerCase()))
				throw new AgentError(`The group "${name}" is listed twice.`);
			groups.add(name.toLocaleLowerCase());
			if (rooms.length === 0)
				throw new AgentError(
					`List at least one agent or group under "${name}".`,
				);
			for (const room of rooms) {
				if (names.has(room)) throw new AgentError(`"${room}" is listed twice.`);
				names.add(room);
				this.#placeable(room);
			}
			return { group: name, names: rooms };
		});
		await provided(() => service.arrange(listed));
		return `Arranged the app's room groups.\n\n${roomGroupsText(await service.view())}`;
	}

	#service(): RoomLayoutService {
		const service = this.#layout();
		if (!service) throw new AgentError(NO_ROOM_GROUPS);
		return service;
	}

	#placeable(name: string): void {
		const agent = this.#store.agent(name);
		const target = agent ?? this.#store.group(name);
		if (!target)
			throw new AgentError(
				`There is no agent or group "${name}"; see agent_list.`,
			);
		if (target.status !== "active")
			throw new AgentError(`"${name}" is archived.`);
		if (agent && isHelper(agent))
			throw new AgentError(
				`"${name}" is a temp knight; its room stays under its knight's.`,
			);
	}
}

/** The app's groups in list order with their rooms, then the pinned rooms. */
export function roomGroupsText(view: RoomGroupsView): string {
	const lines = view.groups.map(
		(group) => `- ${group.name}: ${group.rooms.join(", ") || "empty"}`,
	);
	return `App room groups, in list order:\n${lines.join("\n") || "none"}\nPinned in the app: ${view.pins.join(", ") || "none"}`;
}

/** Runs a change of the provider, its refusal read as the agent's. */
async function provided(change: () => Promise<void>): Promise<void> {
	try {
		await change();
	} catch (error) {
		if (error instanceof AgentError) throw error;
		throw new AgentError(
			error instanceof Error ? error.message : String(error),
		);
	}
}
