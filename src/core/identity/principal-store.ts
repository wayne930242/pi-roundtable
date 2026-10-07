import type { SQL } from "bun";
import type { Pronouns } from "../config/config.ts";
import { IdentityError } from "../domain/errors.ts";
import type { Tier } from "../speakers.ts";
import { isPrincipalId, newPrincipalId } from "./ulid.ts";

/** The principal the host's own turns run as: an ops report, a webhook's. It has no identity, cannot sign in, and keeps no memory. */
export const SYSTEM_PRINCIPAL = "system";

/**
 * The provider of a 0.8 speaker id that stands for a principal of another id, linked at the
 * upgrade; no surface reports it, so no one resolves through it.
 */
export const LEGACY_PROVIDER = "legacy";

/** 0.8's speaker id for the owner writing through an outside agent over MCP: the primary owner. */
export const LEGACY_REMOTE_SPEAKER = "remote-mcp";

export type { Pronouns };

/** A person the host serves, whichever surface they reach it through. */
export interface Principal {
	/** Opaque: a speaker id carried over from 0.8, or `p_<ulid>` for one made since. */
	id: string;
	displayName: string;
	pronouns?: Pronouns;
	disabled: boolean;
}

/** A principal as stored, with when it was made and when it was last seen. */
export interface PrincipalRecord extends Principal {
	locale?: string;
	timeZone?: string;
	createdAt: Date;
	lastSeenAt?: Date;
	/** The tier it was last seen at; it only ever lowers what a background turn may do, never grants. */
	lastTier?: Tier;
	/** Whether the person of its 0.8 speaker id may still claim it: only one the backfill made, until any identity is linked to it. */
	claimable: boolean;
}

/** An identity on one provider: `discord` and a user id, `oidc:<issuer>` and a subject, `token` and a name. */
export interface IdentityRef {
	provider: string;
	subject: string;
}

/** How an identity came to be linked: by the configuration, the CLI, admission on first contact, or a 0.8 speaker id claimed. */
export type LinkSource = "config" | "cli" | "jit" | "legacy";

export interface IdentityLink extends IdentityRef {
	principalId: string;
	source: LinkSource;
	linkedAt: Date;
}

/** Where a role came from. The configuration's are synced at every boot; a CLI grant stays until the CLI revokes it. */
export type RoleSource = "config" | "cli";

export interface RoleGrant {
	role: Tier;
	source: RoleSource;
	grantedAt: Date;
}

/** A principal holding a role, and where the role came from. */
export interface RoleHolder {
	principalId: string;
	source: RoleSource;
}

export interface NewPrincipal {
	/** The id to keep, for a principal carried over from 0.8; otherwise a new `p_` id is made. */
	id?: string;
	displayName: string;
	pronouns?: Pronouns;
}

/** The principals, their linked identities, and their lasting roles. */
export interface PrincipalStore {
	get(id: string): Promise<PrincipalRecord | undefined>;
	list(): Promise<PrincipalRecord[]>;
	/** Refuses an id already taken, and the system principal's. */
	create(input: NewPrincipal): Promise<PrincipalRecord>;
	/** Changes the name or the pronouns; `pronouns: null` clears them. */
	update(
		id: string,
		change: { displayName?: string; pronouns?: Pronouns | null },
	): Promise<PrincipalRecord | undefined>;
	/**
	 * Links the identity to the principal; linking it again to the same one changes nothing, to
	 * another one is refused. A principal with any identity linked is no longer claimable, even
	 * after the identity is unlinked.
	 */
	link(
		principalId: string,
		identity: IdentityRef,
		source: LinkSource,
	): Promise<IdentityLink>;
	/**
	 * The identity's link, claiming the principal for it when the identity is still unlinked and
	 * the principal claimable and not an owner; undefined when it may not be claimed. A principal
	 * is claimed at most once.
	 */
	claim(
		principalId: string,
		identity: IdentityRef,
	): Promise<IdentityLink | undefined>;
	/**
	 * The identity's link, making a new `p_` principal for it, of `id` when given, when it is still
	 * unlinked; however many contacts admit it at once, one principal is made.
	 */
	admit(
		identity: IdentityRef,
		displayName: string,
		id?: string,
	): Promise<IdentityLink>;
	/** Whether there was a link to remove. */
	unlink(provider: string, subject: string): Promise<boolean>;
	identity(
		provider: string,
		subject: string,
	): Promise<IdentityLink | undefined>;
	identitiesOf(principalId: string): Promise<IdentityLink[]>;
	/** Every link made by `source`, such as the configuration's. */
	linksFrom(source: LinkSource): Promise<IdentityLink[]>;
	/** Grants a lasting role. A CLI grant is kept as the CLI's even when the configuration grants the same role. */
	grant(principalId: string, role: Tier, source: RoleSource): Promise<void>;
	/** Revokes the role, or only the grant from `source`; whether there was one to revoke. */
	revoke(
		principalId: string,
		role: Tier,
		source?: RoleSource,
	): Promise<boolean>;
	rolesOf(principalId: string): Promise<RoleGrant[]>;
	/** Every principal holding the role. */
	holders(role: Tier): Promise<RoleHolder[]>;
	disable(id: string): Promise<void>;
	enable(id: string): Promise<void>;
	/** Records that the principal was seen at `at` (default now), at this tier, or null when refused. */
	touch(id: string, tier: Tier | null, at?: Date): Promise<void>;
}

interface PrincipalRow {
	id: string;
	display_name: string;
	pronouns: Pronouns | null;
	locale: string | null;
	time_zone: string | null;
	created_at: Date;
	disabled_at: Date | null;
	last_seen_at: Date | null;
	last_tier: Tier | null;
	claimable: boolean;
}

interface IdentityRow {
	provider: string;
	subject: string;
	principal_id: string;
	source: LinkSource;
	linked_at: Date;
}

interface RoleRow {
	role: Tier;
	source: RoleSource;
	granted_at: Date;
}

function principalOf(row: PrincipalRow): PrincipalRecord {
	return {
		id: row.id,
		displayName: row.display_name,
		...(row.pronouns === null ? {} : { pronouns: row.pronouns }),
		disabled: row.disabled_at !== null,
		...(row.locale === null ? {} : { locale: row.locale }),
		...(row.time_zone === null ? {} : { timeZone: row.time_zone }),
		createdAt: row.created_at,
		...(row.last_seen_at === null ? {} : { lastSeenAt: row.last_seen_at }),
		...(row.last_tier === null ? {} : { lastTier: row.last_tier }),
		claimable: row.claimable,
	};
}

function linkOf(row: IdentityRow): IdentityLink {
	return {
		provider: row.provider,
		subject: row.subject,
		principalId: row.principal_id,
		source: row.source,
		linkedAt: row.linked_at,
	};
}

/** The advisory lock a first contact of this identity holds, so two contacts at once make one link. */
const identityLock = (identity: IdentityRef) =>
	`pi-roundtable:identity:${identity.provider}\n${identity.subject}`;

/** The tables of principals, their identities, and their roles. */
export const PRINCIPAL_TABLES = async (sql: SQL): Promise<void> => {
	await sql`
		CREATE TABLE IF NOT EXISTS principals (
			id text PRIMARY KEY,
			display_name text NOT NULL,
			pronouns text CHECK (pronouns IN ('he', 'she', 'they')),
			locale text,
			time_zone text,
			created_at timestamptz NOT NULL DEFAULT now(),
			disabled_at timestamptz,
			last_seen_at timestamptz,
			last_tier text CHECK (last_tier IN ('member', 'admin', 'owner'))
		)`;
	await sql`
		CREATE TABLE IF NOT EXISTS principal_identities (
			provider text NOT NULL,
			subject text NOT NULL,
			principal_id text NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
			linked_at timestamptz NOT NULL DEFAULT now(),
			source text NOT NULL CHECK (source IN ('config', 'cli', 'jit', 'legacy')),
			PRIMARY KEY (provider, subject)
		)`;
	await sql`
		CREATE INDEX IF NOT EXISTS principal_identities_principal
		ON principal_identities (principal_id)`;
	await sql`
		CREATE TABLE IF NOT EXISTS principal_roles (
			principal_id text NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
			role text NOT NULL CHECK (role IN ('member', 'admin', 'owner')),
			source text NOT NULL CHECK (source IN ('config', 'cli')),
			granted_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (principal_id, role)
		)`;
};

/**
 * Whether the person of a carried-over principal's 0.8 id may still claim it: its own migration,
 * so a database whose principals table an earlier build made gets the column too.
 */
export const PRINCIPALS_CLAIMABLE = async (sql: SQL): Promise<void> => {
	await sql`ALTER TABLE principals ADD COLUMN IF NOT EXISTS claimable boolean NOT NULL DEFAULT false`;
};

/** The principal store over the `principals`, `principal_identities`, and `principal_roles` tables. */
export class PgPrincipalStore implements PrincipalStore {
	readonly #sql: SQL;

	private constructor(sql: SQL) {
		this.#sql = sql;
	}

	/** The store over the host's migrated pool. */
	static async attach(sql: SQL): Promise<PgPrincipalStore> {
		return new PgPrincipalStore(sql);
	}

	async get(id: string): Promise<PrincipalRecord | undefined> {
		const rows: PrincipalRow[] = await this.#sql`
			SELECT * FROM principals WHERE id = ${id}`;
		const [row] = rows;
		return row ? principalOf(row) : undefined;
	}

	async list(): Promise<PrincipalRecord[]> {
		const rows: PrincipalRow[] = await this.#sql`
			SELECT * FROM principals ORDER BY created_at, id`;
		return rows.map(principalOf);
	}

	async create(input: NewPrincipal): Promise<PrincipalRecord> {
		const id = input.id ?? newPrincipalId();
		if (id === SYSTEM_PRINCIPAL)
			throw new IdentityError(
				`"${SYSTEM_PRINCIPAL}" is the host's own principal; give another id`,
			);
		const rows: PrincipalRow[] = await this.#sql`
			INSERT INTO principals (id, display_name, pronouns)
			VALUES (${id}, ${input.displayName}, ${input.pronouns ?? null})
			ON CONFLICT (id) DO NOTHING
			RETURNING *`;
		const [row] = rows;
		if (!row) throw new IdentityError(`principal ${id} already exists`);
		return principalOf(row);
	}

	async update(
		id: string,
		change: { displayName?: string; pronouns?: Pronouns | null },
	): Promise<PrincipalRecord | undefined> {
		const keepPronouns = change.pronouns === undefined;
		const rows: PrincipalRow[] = await this.#sql`
			UPDATE principals SET
				display_name = COALESCE(${change.displayName ?? null}::text, display_name),
				pronouns = CASE WHEN ${keepPronouns}::boolean THEN pronouns ELSE ${change.pronouns ?? null}::text END
			WHERE id = ${id}
			RETURNING *`;
		const [row] = rows;
		return row ? principalOf(row) : undefined;
	}

	async link(
		principalId: string,
		identity: IdentityRef,
		source: LinkSource,
	): Promise<IdentityLink> {
		if (principalId === SYSTEM_PRINCIPAL)
			throw new IdentityError(
				`the host's own principal "${SYSTEM_PRINCIPAL}" has no identities`,
			);
		const { provider, subject } = identity;
		// The same lock, and the same order of writes, as a first contact's claim of this identity,
		// so the two at once queue instead of deadlocking.
		return this.#sql.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(hashtextextended(${identityLock(identity)}, 0))`;
			const linked: IdentityRow[] = await tx`
				SELECT * FROM principal_identities WHERE provider = ${provider} AND subject = ${subject}`;
			const [existing] = linked;
			if (existing) {
				if (existing.principal_id !== principalId)
					throw new IdentityError(
						`${provider}:${subject} is already linked to principal ${existing.principal_id}; unlink it first`,
					);
				return linkOf(existing);
			}
			const spent = await tx`
				UPDATE principals SET claimable = false WHERE id = ${principalId}
				RETURNING id`;
			if (spent.length === 0)
				throw new IdentityError(`there is no principal ${principalId}`);
			const made: IdentityRow[] = await tx`
				INSERT INTO principal_identities (provider, subject, principal_id, source)
				VALUES (${provider}, ${subject}, ${principalId}, ${source})
				RETURNING *`;
			const [link] = made;
			if (!link)
				throw new IdentityError(`could not link ${provider}:${subject}`);
			return linkOf(link);
		});
	}

	async claim(
		principalId: string,
		identity: IdentityRef,
	): Promise<IdentityLink | undefined> {
		const { provider, subject } = identity;
		return this.#sql.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(hashtextextended(${identityLock(identity)}, 0))`;
			const linked: IdentityRow[] = await tx`
				SELECT * FROM principal_identities WHERE provider = ${provider} AND subject = ${subject}`;
			if (linked[0]) return linkOf(linked[0]);
			const taken = await tx`
				UPDATE principals SET claimable = false
				WHERE id = ${principalId} AND claimable AND NOT EXISTS (
					SELECT 1 FROM principal_roles WHERE principal_id = ${principalId} AND role = 'owner'
				)
				RETURNING id`;
			if (taken.length === 0) return undefined;
			const made: IdentityRow[] = await tx`
				INSERT INTO principal_identities (provider, subject, principal_id, source)
				VALUES (${provider}, ${subject}, ${principalId}, 'legacy')
				RETURNING *`;
			return made[0] && linkOf(made[0]);
		});
	}

	async admit(
		identity: IdentityRef,
		displayName: string,
		id = newPrincipalId(),
	): Promise<IdentityLink> {
		const { provider, subject } = identity;
		return this.#sql.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(hashtextextended(${identityLock(identity)}, 0))`;
			const linked: IdentityRow[] = await tx`
				SELECT * FROM principal_identities WHERE provider = ${provider} AND subject = ${subject}`;
			if (linked[0]) return linkOf(linked[0]);
			if (!isPrincipalId(id))
				throw new IdentityError(`a new principal's id is p_<ulid>, not ${id}`);
			await tx`INSERT INTO principals (id, display_name) VALUES (${id}, ${displayName})`;
			const made: IdentityRow[] = await tx`
				INSERT INTO principal_identities (provider, subject, principal_id, source)
				VALUES (${provider}, ${subject}, ${id}, 'jit')
				RETURNING *`;
			const [link] = made;
			if (!link)
				throw new IdentityError(`could not link ${provider}:${subject}`);
			return linkOf(link);
		});
	}

	async unlink(provider: string, subject: string): Promise<boolean> {
		const rows = await this.#sql`
			DELETE FROM principal_identities WHERE provider = ${provider} AND subject = ${subject}
			RETURNING provider`;
		return rows.length > 0;
	}

	async identity(
		provider: string,
		subject: string,
	): Promise<IdentityLink | undefined> {
		const rows: IdentityRow[] = await this.#sql`
			SELECT * FROM principal_identities WHERE provider = ${provider} AND subject = ${subject}`;
		const [row] = rows;
		return row ? linkOf(row) : undefined;
	}

	async identitiesOf(principalId: string): Promise<IdentityLink[]> {
		const rows: IdentityRow[] = await this.#sql`
			SELECT * FROM principal_identities WHERE principal_id = ${principalId}
			ORDER BY provider, subject`;
		return rows.map(linkOf);
	}

	async linksFrom(source: LinkSource): Promise<IdentityLink[]> {
		const rows: IdentityRow[] = await this.#sql`
			SELECT * FROM principal_identities WHERE source = ${source}
			ORDER BY provider, subject`;
		return rows.map(linkOf);
	}

	async grant(
		principalId: string,
		role: Tier,
		source: RoleSource,
	): Promise<void> {
		const rows = await this.#sql`
			INSERT INTO principal_roles (principal_id, role, source)
			SELECT id, ${role}, ${source} FROM principals WHERE id = ${principalId}
			ON CONFLICT (principal_id, role) DO UPDATE SET
				source = CASE WHEN principal_roles.source = 'cli' THEN 'cli' ELSE EXCLUDED.source END
			RETURNING role`;
		if (rows.length === 0)
			throw new IdentityError(`there is no principal ${principalId}`);
	}

	async revoke(
		principalId: string,
		role: Tier,
		source?: RoleSource,
	): Promise<boolean> {
		const rows =
			source === undefined
				? await this.#sql`
					DELETE FROM principal_roles WHERE principal_id = ${principalId} AND role = ${role}
					RETURNING role`
				: await this.#sql`
					DELETE FROM principal_roles
					WHERE principal_id = ${principalId} AND role = ${role} AND source = ${source}
					RETURNING role`;
		return rows.length > 0;
	}

	async rolesOf(principalId: string): Promise<RoleGrant[]> {
		const rows: RoleRow[] = await this.#sql`
			SELECT role, source, granted_at FROM principal_roles WHERE principal_id = ${principalId}
			ORDER BY role`;
		return rows.map((row) => ({
			role: row.role,
			source: row.source,
			grantedAt: row.granted_at,
		}));
	}

	async holders(role: Tier): Promise<RoleHolder[]> {
		const rows: { principal_id: string; source: RoleSource }[] = await this
			.#sql`
			SELECT principal_id, source FROM principal_roles WHERE role = ${role}
			ORDER BY principal_id`;
		return rows.map((row) => ({
			principalId: row.principal_id,
			source: row.source,
		}));
	}

	async disable(id: string): Promise<void> {
		await this.#sql`
			UPDATE principals SET disabled_at = COALESCE(disabled_at, now()) WHERE id = ${id}`;
	}

	async enable(id: string): Promise<void> {
		await this.#sql`UPDATE principals SET disabled_at = NULL WHERE id = ${id}`;
	}

	async touch(id: string, tier: Tier | null, at = new Date()): Promise<void> {
		await this.#sql`
			UPDATE principals SET last_seen_at = ${at}, last_tier = ${tier} WHERE id = ${id}`;
	}
}
