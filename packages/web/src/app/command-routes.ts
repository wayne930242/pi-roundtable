import type { ChatCommand, Speaker } from "pi-roundtable";
import type { RoomCommandsView } from "../api-types.ts";
import { json } from "../http.ts";
import type { ResolvedRoom } from "./rooms.ts";

export interface CommandRoutesOptions {
	/** The Pi extension commands plugins declared safe to run from chat. */
	declared(): readonly ChatCommand[];
	/** The skills an agent carries, built-in ones included; absent when the host has no skills addon. */
	skillsOf?(agent: string): readonly { name: string; description: string }[];
}

/**
 * `GET api/rooms/<room>/commands`: what the owner may run by typing `/` in the room's message box,
 * beyond the commands the page runs itself (`/clear`, `/new`). An agent's room offers the skills the
 * agent carries (`/skill:<name>`) and the extension commands plugins declared; a group, a thread
 * and a room that cannot be written in offer none. Both kinds are sent as a normal message, and only
 * an owner's message is ever read as a command, so the route is the owner's.
 */
export class CommandRoutes {
	readonly #options: CommandRoutesOptions;

	constructor(options: CommandRoutesOptions) {
		this.#options = options;
	}

	list(room: ResolvedRoom, _owner: Speaker): Response {
		if (room.kind !== "agent" || room.readOnly)
			return json({ commands: [] } satisfies RoomCommandsView);
		const { declared, skillsOf } = this.#options;
		const skills = (skillsOf?.(room.name) ?? []).map((skill) => ({
			name: `skill:${skill.name}`,
			description: skill.description,
			source: "skill" as const,
		}));
		const extensions = declared().map((command) => ({
			name: command.name,
			description: command.description,
			source: "extension" as const,
		}));
		return json({
			commands: [...skills, ...extensions],
		} satisfies RoomCommandsView);
	}
}
