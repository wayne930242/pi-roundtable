import type {
	AgentDirectory,
	AgentTeam,
	ChannelKey,
	Speaker,
} from "pi-roundtable";
import { agentRoomKey, isHelper, roomOf } from "pi-roundtable";
import type { HelpersArchived, HelpersRestored } from "../api-types.ts";
import { json } from "../http.ts";
import { bad, bodyOf } from "./api-http.ts";

/** The most rooms or names one request of these routes names. */
const MAX_NAMED = 500;

export interface HelperRoutesOptions {
	surface: string;
	directory: Pick<AgentDirectory, "agent" | "agents">;
	team: Pick<
		AgentTeam,
		"finishedHelpers" | "archiveHelpers" | "restoreHelpers"
	>;
	changed(): void;
}

/** A list of at most 500 strings, or undefined when the body leaves it out. */
function listOf(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (
		!Array.isArray(value) ||
		value.length > MAX_NAMED ||
		!value.every((one) => typeof one === "string" && one.length <= 300)
	)
		throw bad(`${field} must be a list of at most ${MAX_NAMED} strings.`);
	return value;
}

/**
 * The two bulk calls on temp knights, for owners: archiving the finished ones of some knights (or
 * of every knight) and putting back the ones an archive took. They reach the same team operations
 * as the knight's own `helper_end`.
 */
export class HelperRoutes {
	readonly #options: HelperRoutesOptions;

	constructor(options: HelperRoutesOptions) {
		this.#options = options;
	}

	/**
	 * `POST api/rooms/archive-finished-helpers`: archives the finished temp knights of the named
	 * knights' rooms, or of every knight when none is named. Answers what it archived by room.
	 */
	async archiveFinished(request: Request, owner: Speaker): Promise<Response> {
		const { surface, directory, team } = this.#options;
		const keys = listOf((await bodyOf(request)).rooms, "rooms");
		let parents: string[] | undefined;
		if (keys) {
			parents = [];
			for (const key of new Set(keys)) {
				const named = roomOf(key as ChannelKey, [surface]);
				const agent =
					named?.kind === "agent" ? directory.agent(named.name) : undefined;
				if (!agent || isHelper(agent))
					throw bad(`"${key}" is not the room of a knight.`);
				parents.push(agent.name);
			}
		}
		const finished = team.finishedHelpers(parents);
		const byParent = new Map<string, string[]>();
		for (const helper of finished)
			byParent.set(helper.parent as string, [
				...(byParent.get(helper.parent as string) ?? []),
				helper.name,
			]);
		const done = new Set(
			await team.archiveHelpers(
				finished.map((helper) => helper.name),
				owner.principalId ?? owner.name,
			),
		);
		const archived = [...byParent]
			.map(([parent, names]) => ({
				room: agentRoomKey(surface, parent),
				names: names.filter((name) => done.has(name)),
			}))
			.filter((entry) => entry.names.length > 0);
		if (archived.length > 0) this.#options.changed();
		return json({ archived } satisfies HelpersArchived);
	}

	/**
	 * `POST api/rooms/restore-helpers`: puts back archived temp knights, the undo of an archive. A
	 * name that is not a temp knight is refused by name; one no longer archived is passed over.
	 */
	async restore(request: Request): Promise<Response> {
		const { directory, team } = this.#options;
		const names = listOf((await bodyOf(request)).names, "names");
		if (!names) throw bad("Give names, the temp knights to restore.");
		for (const name of names)
			if (!isHelper(directory.agent(name)))
				throw bad(`"${name}" is not a temp knight.`);
		const restored = await team.restoreHelpers([...new Set(names)]);
		if (restored.length > 0) this.#options.changed();
		return json({ restored } satisfies HelpersRestored);
	}
}
