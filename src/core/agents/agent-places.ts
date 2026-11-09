import type { SQL } from "bun";
import {
	LEGACY_CHANNEL_SURFACE,
	warnSharedChannel,
} from "../db/legacy-channels.ts";

/** What a place belongs to: an agent or a group, by name. */
export type PlaceOwnerKind = "agent" | "group";

/** A stored place: the id the surface gave it, for one owner on one surface. */
export interface StoredPlace {
	kind: PlaceOwnerKind;
	name: string;
	surface: string;
	externalId: string;
}

interface PlaceRow {
	kind: PlaceOwnerKind;
	name: string;
	surface: string;
	external_id: string;
}

/** A row a write returned, which carries the legacy `channel_id` the place follows. */
interface LegacyRow {
	name: string;
	channel_id: string | null;
}

const ownerKey = (kind: PlaceOwnerKind, name: string, surface: string) =>
	`${kind}\0${name}\0${surface}`;
const idKey = (surface: string, externalId: string) =>
	`${surface}\0${externalId}`;

/**
 * The stored places of one team, in the database and in memory, so an inbound message's owner
 * lookup reads no database. A team's agents and groups have at most one place per surface.
 *
 * Until 1.0 the legacy `channel_id` columns hold the same place as the row of the legacy surface:
 * `legacy` and `dropping` write both in the transaction of the write that changed the column, and
 * the memory follows once it commits.
 */
export class AgentPlaces {
	readonly #sql: SQL;
	readonly #team: string;
	readonly #byOwner = new Map<string, StoredPlace>();
	readonly #byId = new Map<string, StoredPlace>();

	private constructor(sql: SQL, teamId: string) {
		this.#sql = sql;
		this.#team = teamId;
	}

	/** The places of the team, read from the table. */
	static async load(sql: SQL, teamId: string): Promise<AgentPlaces> {
		const places = new AgentPlaces(sql, teamId);
		await places.reload();
		return places;
	}

	/** No place read: `Roundtable.check()` has no database to read them from. */
	static empty(sql: SQL, teamId: string): AgentPlaces {
		return new AgentPlaces(sql, teamId);
	}

	async reload(): Promise<void> {
		const rows: PlaceRow[] = await this
			.#sql`SELECT kind, name, surface, external_id FROM agent_places WHERE team_id = ${this.#team}`;
		this.#byOwner.clear();
		this.#byId.clear();
		for (const row of rows)
			this.#remember({
				kind: row.kind,
				name: row.name,
				surface: row.surface,
				externalId: row.external_id,
			});
	}

	/** Every place of the agent or group, one per surface. */
	of(kind: PlaceOwnerKind, name: string): StoredPlace[] {
		return [...this.#byOwner.values()].filter(
			(place) => place.kind === kind && place.name === name,
		);
	}

	/** The id of the owner's place on the surface. */
	on(kind: PlaceOwnerKind, name: string, surface: string): string | undefined {
		return this.#byOwner.get(ownerKey(kind, name, surface))?.externalId;
	}

	/** The owner of the place with this id on the surface. */
	ownerOf(
		surface: string,
		externalId: string,
	): { kind: PlaceOwnerKind; name: string } | undefined {
		const place = this.#byId.get(idKey(surface, externalId));
		return place && { kind: place.kind, name: place.name };
	}

	/**
	 * Runs a write that sets or keeps a legacy `channel_id` and returns the rows it wrote; in the same
	 * transaction each row's legacy-surface place is made equal to its column, a null column
	 * deleting the place.
	 */
	async legacy<R extends LegacyRow>(
		kind: PlaceOwnerKind,
		write: (tx: SQL) => Promise<R[]>,
	): Promise<R[]> {
		const applied: (() => void)[] = [];
		const rows = await this.#sql.begin(async (tx) => {
			const written = await write(tx);
			for (const row of written)
				applied.push(await this.#follow(tx, kind, row.name, row.channel_id));
			return written;
		});
		for (const apply of applied) apply();
		return rows;
	}

	/** Runs a write that deletes the owner's rows and, in the same transaction, every place it had. */
	async dropping(
		kind: PlaceOwnerKind,
		name: string,
		write: (tx: SQL) => Promise<void>,
	): Promise<void> {
		await this.#sql.begin(async (tx) => {
			await write(tx);
			await tx`
				DELETE FROM agent_places
				WHERE team_id = ${this.#team} AND kind = ${kind} AND name = ${name}`;
		});
		for (const place of this.of(kind, name)) this.#forget(place);
	}

	async #follow(
		tx: SQL,
		kind: PlaceOwnerKind,
		name: string,
		channelId: string | null,
	): Promise<() => void> {
		const owner = { kind, name, surface: LEGACY_CHANNEL_SURFACE };
		if (channelId === null) {
			await tx`
				DELETE FROM agent_places
				WHERE team_id = ${this.#team} AND kind = ${kind} AND name = ${name}
					AND surface = ${owner.surface}`;
			return () => {
				const place = this.#byOwner.get(
					ownerKey(kind, name, LEGACY_CHANNEL_SURFACE),
				);
				if (place) this.#forget(place);
			};
		}
		// A place id belongs to one owner: the column keeps the id, and the owner has no row for it.
		const [holder]: { kind: PlaceOwnerKind; name: string }[] = await tx`
			SELECT kind, name FROM agent_places
			WHERE team_id = ${this.#team} AND surface = ${owner.surface} AND external_id = ${channelId}
				AND NOT (kind = ${kind} AND name = ${name})`;
		if (holder) {
			warnSharedChannel(this.#team, owner, channelId, holder);
			await tx`
				DELETE FROM agent_places
				WHERE team_id = ${this.#team} AND kind = ${kind} AND name = ${name}
					AND surface = ${owner.surface}`;
			return () => {
				const place = this.#byOwner.get(ownerKey(kind, name, owner.surface));
				if (place) this.#forget(place);
			};
		}
		await tx`
			INSERT INTO agent_places (team_id, kind, name, surface, external_id)
			VALUES (${this.#team}, ${kind}, ${name}, ${owner.surface}, ${channelId})
			ON CONFLICT (team_id, kind, name, surface)
			DO UPDATE SET external_id = EXCLUDED.external_id`;
		return () => this.#replace({ ...owner, externalId: channelId });
	}

	#replace(place: StoredPlace): void {
		const current = this.#byOwner.get(
			ownerKey(place.kind, place.name, place.surface),
		);
		if (current) this.#forget(current);
		this.#remember(place);
	}

	#remember(place: StoredPlace): void {
		this.#byOwner.set(ownerKey(place.kind, place.name, place.surface), place);
		this.#byId.set(idKey(place.surface, place.externalId), place);
	}

	#forget(place: StoredPlace): void {
		this.#byOwner.delete(ownerKey(place.kind, place.name, place.surface));
		this.#byId.delete(idKey(place.surface, place.externalId));
	}
}
