import type { SQL } from "bun";
import { IdentityError } from "../domain/errors.ts";
import type { Tier } from "../speakers.ts";
import { newPrincipalId } from "./ulid.ts";

/** The principal the host's own turns run as: an ops report, a webhook's. It has no identity, cannot sign in, and keeps no memory. */
export const SYSTEM_PRINCIPAL = "system";

export type Pronouns = "he" | "she" | "they";

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
	/** Links the identity to the principal; linking it again to the same one changes nothing, to another one is refused. */
	link(
		principalId: string,
		identity: IdentityRef,
		source: LinkSource,
	): Promise<IdentityLink>;
	/** Whether there was a link to remove. */
	unlink(provider: string, subject: string): Promise<boolean>;
	identity(provider: string, subject: string): Promise<IdentityLink | undefined>;
	identitiesOf(principalId: string): Promise<IdentityLink[]>;
	/** Grants a lasting role. A CLI grant is kept as the CLI's even when the configuration grants the same role. */
	grant(principalId: string, role: Tier, source: RoleSource): Promise<void>;
	/** Revokes the role, or only the grant from `source`; whether there was one to revoke. */
	revoke(principalId: string, role: Tier, source?: RoleSource): Promise<boolean>;
	rolesOf(principalId: string): Promise<RoleGrant[]>;
	disable(id: string): Promise<void>;
	enable(id: string): Promise<void>;
	/** Records that the principal was seen now, at this tier. */
	touch(id: string, tier: Tier): Promise<void>;
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
		const rows: IdentityRow[] = await this.#sql`
			INSERT INTO principal_identities (provider, subject, principal_id, source)
			SELECT ${provider}, ${subject}, id, ${source} FROM principals WHERE id = ${principalId}
			ON CONFLICT (provider, subject) DO NOTHING
			RETURNING *`;
		const [made] = rows;
		if (made) return linkOf(made);
		const existing = await this.identity(provider, subject);
		if (!existing)
			throw new IdentityError(`there is no principal ${principalId}`);
		if (existing.principalId !== principalId)
			throw new IdentityError(
				`${provider}:${subject} is already linked to principal ${existing.principalId}; unlink it first`,
			);
		return existing;
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

	async disable(id: string): Promise<void> {
		await this.#sql`
			UPDATE principals SET disabled_at = COALESCE(disabled_at, now()) WHERE id = ${id}`;
	}

	async enable(id: string): Promise<void> {
		await this.#sql`UPDATE principals SET disabled_at = NULL WHERE id = ${id}`;
	}

	async touch(id: string, tier: Tier): Promise<void> {
		await this.#sql`
			UPDATE principals SET last_seen_at = now(), last_tier = ${tier} WHERE id = ${id}`;
	}
}
