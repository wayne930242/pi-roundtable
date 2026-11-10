import type { SQL } from "bun";
import {
	LEGACY_CHANNEL_SURFACE,
	setLegacyChannel,
} from "../db/legacy-channels.ts";
import { AgentError } from "../domain/errors.ts";
import { AgentBook } from "./agent-book.ts";
import type { AgentPlaces, PlaceOwnerKind } from "./agent-places.ts";
import {
	type AgentGroup,
	type Backlog,
	checkDisplayName,
	type GroupMessage,
} from "./agent-rules.ts";
import type { AgentRow, GroupRow } from "./agent-schema.ts";
import { AgentStatements } from "./agent-statements.ts";
import { GroupMessages } from "./group-messages.ts";

/**
 * The write queue and the group half of the agent store: groups, their messages and their
 * cursors, in the database and in the memory the book holds. The agent half is `PgAgentStore`.
 */
export abstract class AgentGroupStore extends AgentBook {
	protected readonly sql: SQL;
	protected readonly teamId: string;
	protected readonly statements: AgentStatements;
	/** The stored places of the team's agents and groups. */
	readonly places: AgentPlaces;
	readonly #messages: GroupMessages;
	/** The tail of the agent and group writes, which run one at a time so none reads a map another is about to change. */
	#queue: Promise<unknown> = Promise.resolve();

	protected constructor(sql: SQL, teamId: string, places: AgentPlaces) {
		super();
		this.sql = sql;
		this.teamId = teamId;
		this.places = places;
		this.statements = new AgentStatements(sql, teamId);
		this.#messages = new GroupMessages(sql, teamId);
	}

	/** The statements over a transaction, for a write that commits with its place rows. */
	protected statementsOn(tx: SQL): AgentStatements {
		return new AgentStatements(tx, this.teamId);
	}

	protected serial<T>(write: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(write);
		this.#queue = run.catch(() => undefined);
		return run;
	}

	/**
	 * Records the place an agent or group has on a surface, in place of the one it had there. Until
	 * 1.0 the place of the surface the legacy `channel_id` columns hold is written to its column as
	 * well, in the same transaction.
	 */
	async setPlace(
		kind: PlaceOwnerKind,
		name: string,
		surface: string,
		id: string,
	): Promise<void> {
		return this.#writePlace(kind, name, surface, id);
	}

	/** Forgets the place an agent or group has on a surface; the place itself stays where it is. */
	async clearPlace(
		kind: PlaceOwnerKind,
		name: string,
		surface: string,
	): Promise<void> {
		return this.#writePlace(kind, name, surface, null);
	}

	#writePlace(
		kind: PlaceOwnerKind,
		name: string,
		surface: string,
		id: string | null,
	): Promise<void> {
		return this.serial(async () => {
			const known =
				kind === "agent" ? this.agentMap.has(name) : this.groupMap.has(name);
			if (!known) throw new AgentError(`There is no ${kind} "${name}".`);
			if (surface !== LEGACY_CHANNEL_SURFACE) {
				if (id === null) await this.places.unbind(kind, name, surface);
				else await this.places.bind(kind, name, surface, id);
				return;
			}
			if (kind === "agent") {
				const rows = await this.places.legacy(
					"agent",
					async (tx) =>
						(await setLegacyChannel(
							tx,
							kind,
							this.teamId,
							name,
							id,
						)) as AgentRow[],
				);
				this.keepAgent(rows[0]);
			} else {
				const rows = await this.places.legacy(
					"group",
					async (tx) =>
						(await setLegacyChannel(
							tx,
							kind,
							this.teamId,
							name,
							id,
						)) as GroupRow[],
				);
				this.keepGroup(rows[0]);
			}
		});
	}

	async createGroup(group: {
		name: string;
		displayName: string;
		/** Absent in a team without Discord, whose groups live in rooms. */
		channelId?: string;
		members: string[];
		host: string;
	}): Promise<AgentGroup> {
		return this.serial(async () => {
			this.checkNewGroup(group.name, group.members, group.host);
			checkDisplayName(group.displayName);
			const rows = await this.places.legacy("group", (tx) =>
				this.statementsOn(tx).insertGroup({
					...group,
					displayName: group.displayName.trim(),
					channelId: group.channelId ?? null,
				}),
			);
			return this.keepGroup(rows[0]);
		});
	}

	async updateGroup(
		name: string,
		change: { displayName?: string; members?: string[]; host?: string },
	): Promise<AgentGroup> {
		return this.serial(async () => {
			const current = this.groupMap.get(name);
			if (current?.status !== "active")
				throw new AgentError(`There is no active group "${name}".`);
			if (change.displayName !== undefined)
				checkDisplayName(change.displayName);
			const members = change.members ?? current.members;
			const host =
				change.host ??
				(members.includes(current.host) ? current.host : (members[0] ?? ""));
			this.checkMembers(members, host);
			return this.writeGroup(name, {
				displayName: change.displayName?.trim() ?? current.displayName,
				members,
				host,
				status: "active",
			});
		});
	}

	async archiveGroup(name: string): Promise<AgentGroup> {
		return this.serial(() => this.writeGroup(name, { status: "archived" }));
	}

	/**
	 * Returns an archived group to the active ones, on a new channel when its old one is gone. Its
	 * members must all be active still and number enough; otherwise it refuses and stays archived.
	 */
	async restoreGroup(name: string, channelId?: string): Promise<AgentGroup> {
		return this.serial(async () => {
			const current = this.checkRestorableGroup(name);
			const rows = await this.places.legacy("group", (tx) =>
				this.statementsOn(tx).restoreGroup(
					name,
					channelId ?? current.channelId ?? null,
				),
			);
			return this.keepGroup(rows[0]);
		});
	}

	/**
	 * Deletes an archived group with its messages and cursors, in the Discord channel's log and in
	 * each room's (`<group>@<surface>`); its name is free again. An active group is never deleted.
	 */
	async deleteGroup(name: string): Promise<void> {
		return this.serial(async () => {
			const current = this.groupMap.get(name);
			if (!current) throw new AgentError(`There is no group "${name}".`);
			if (current.status === "active")
				throw new AgentError(
					`"${name}" is active; archive it before deleting it.`,
				);
			await this.places.dropping("group", name, (tx) =>
				this.statementsOn(tx).deleteGroup(name),
			);
			this.groupMap.delete(name);
		});
	}

	protected async writeGroup(
		name: string,
		change: Partial<
			Pick<AgentGroup, "displayName" | "members" | "host" | "status">
		>,
	): Promise<AgentGroup> {
		const current = this.groupMap.get(name);
		if (!current) throw new AgentError(`There is no group "${name}".`);
		const rows = await this.statements.updateGroup(name, {
			displayName: change.displayName ?? current.displayName,
			members: change.members ?? current.members,
			host: change.host ?? current.host,
			status: change.status ?? current.status,
		});
		return this.keepGroup(rows[0]);
	}

	appendGroupMessage(
		group: string,
		message: { author: string; authorName: string; text: string },
	): Promise<number> {
		return this.#messages.append(group, message);
	}

	/** The group's newest messages, oldest first. */
	recentGroupMessages(group: string, limit: number): Promise<GroupMessage[]> {
		return this.#messages.recent(group, limit);
	}

	/** Group messages the member has not received yet, its own excluded; the newest `limit` are carried. */
	backlog(group: string, agent: string, limit: number): Promise<Backlog> {
		return this.#messages.backlog(group, agent, limit);
	}

	advanceCursor(group: string, agent: string, lastId: number): Promise<void> {
		return this.#messages.advanceCursor(group, agent, lastId);
	}

	/** Marks every message so far as received by every member, for a group started over. */
	catchUp(group: AgentGroup, log?: string): Promise<void> {
		return this.#messages.catchUp(group, log);
	}
}
