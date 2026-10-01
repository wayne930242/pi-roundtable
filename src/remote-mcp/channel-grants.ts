import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SQL } from "bun";
import type { Migration } from "pi-roundtable";
import type { ChannelOperation } from "pi-roundtable/discord";

/** A bundle is one MCP URL; its token is shown once and only its hash is kept. */
export interface ChannelBundle {
	id: string;
	name: string;
	tokenHash: string;
	defaultOperations: ChannelOperation[];
}

export interface ChannelGrant {
	bundleId: string;
	channelId: string;
	guildId: string;
	operations: ChannelOperation[];
	/** The name and purpose an agent sees; Discord's own name is untouched. */
	displayName: string;
	description: string;
	/** Last known names, shown when the channel can no longer be fetched. */
	guildName: string;
	channelName: string;
	authorizedBy: string;
	authorizedAt: Date;
}

export interface ChannelAudit {
	tool: string;
	status: string;
	createdAt: Date;
}

export const hashChannelToken = (token: string): string =>
	createHash("sha256").update(token).digest("hex");

/** A fresh bundle URL under the public base; the token appears only in the returned URL. */
export function newChannelEndpoint(publicBaseUrl: string): {
	url: string;
	tokenHash: string;
} {
	const base = URL.parse(publicBaseUrl);
	if (!base) throw new Error("MCP public URL is not a URL");
	if (base.protocol !== "https:")
		throw new Error("MCP public URL must use HTTPS");
	const token = randomBytes(32).toString("base64url");
	return {
		url: new URL(`/mcp/discord/${token}`, base.origin).href,
		tokenHash: hashChannelToken(token),
	};
}

/** A bundle token as it appears in a URL: 32 random bytes in base64url. */
export const CHANNEL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface BundleRow {
	id: string;
	name: string;
	token_hash: string;
	default_operations: ChannelOperation[];
}

interface GrantRow {
	bundle_id: string;
	channel_id: string;
	guild_id: string;
	operations: ChannelOperation[];
	display_name: string;
	description: string;
	guild_name: string;
	channel_name: string;
	authorized_by: string;
	authorized_at: Date;
}

const toBundle = (row: BundleRow): ChannelBundle => ({
	id: row.id,
	name: row.name,
	tokenHash: row.token_hash,
	defaultOperations: row.default_operations,
});

const toGrant = (row: GrantRow): ChannelGrant => ({
	bundleId: row.bundle_id,
	channelId: row.channel_id,
	guildId: row.guild_id,
	operations: row.operations,
	displayName: row.display_name,
	description: row.description,
	guildName: row.guild_name,
	channelName: row.channel_name,
	authorizedBy: row.authorized_by,
	authorizedAt: row.authorized_at,
});

/** The owner's channel grants for outside agents, in the host's database. */
export class ChannelGrantStore {
	readonly #sql: SQL;

	private constructor(sql: SQL) {
		this.#sql = sql;
	}

	/** The store's tables; the host runs this before any store attaches. */
	static readonly migration: Migration = {
		name: "channel-grants",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS discord_mcp_bundles (
					id uuid PRIMARY KEY,
					name text NOT NULL UNIQUE,
					token_hash text NOT NULL UNIQUE,
					default_operations jsonb NOT NULL DEFAULT '[]'::jsonb,
					created_at timestamptz NOT NULL DEFAULT now()
				)`;
			await sql`
				CREATE TABLE IF NOT EXISTS discord_channel_grants (
					bundle_id uuid NOT NULL REFERENCES discord_mcp_bundles (id) ON DELETE CASCADE,
					channel_id text NOT NULL,
					guild_id text NOT NULL,
					operations jsonb NOT NULL,
					display_name text NOT NULL,
					description text NOT NULL DEFAULT '',
					guild_name text NOT NULL,
					channel_name text NOT NULL,
					authorized_by text NOT NULL,
					authorized_at timestamptz NOT NULL DEFAULT now(),
					PRIMARY KEY (bundle_id, channel_id)
				)`;
			await sql`
				CREATE TABLE IF NOT EXISTS discord_channel_audit (
					id uuid PRIMARY KEY,
					bundle_id uuid,
					channel_id text NOT NULL,
					guild_id text,
					tool text NOT NULL,
					arguments_digest text,
					status text NOT NULL,
					created_at timestamptz NOT NULL DEFAULT now()
				)`;
		},
	};

	/** The store over the host's migrated pool. */
	static async attach(sql: SQL): Promise<ChannelGrantStore> {
		return new ChannelGrantStore(sql);
	}

	async bundles(): Promise<ChannelBundle[]> {
		const rows: BundleRow[] = await this.#sql`
			SELECT id, name, token_hash, default_operations FROM discord_mcp_bundles ORDER BY name`;
		return rows.map(toBundle);
	}

	async bundleByName(name: string): Promise<ChannelBundle | undefined> {
		const rows: BundleRow[] = await this.#sql`
			SELECT id, name, token_hash, default_operations FROM discord_mcp_bundles WHERE name = ${name}`;
		return rows[0] && toBundle(rows[0]);
	}

	async bundleByTokenHash(
		tokenHash: string,
	): Promise<ChannelBundle | undefined> {
		const rows: BundleRow[] = await this.#sql`
			SELECT id, name, token_hash, default_operations FROM discord_mcp_bundles
			WHERE token_hash = ${tokenHash}`;
		return rows[0] && toBundle(rows[0]);
	}

	/**
	 * The named bundle, created with this token hash when it does not exist yet. `created`
	 * tells the caller whether the new URL is the one in effect.
	 */
	async ensureBundle(
		name: string,
		tokenHash: string,
		defaultOperations: ChannelOperation[],
	): Promise<{ bundle: ChannelBundle; created: boolean }> {
		const inserted: BundleRow[] = await this.#sql`
			INSERT INTO discord_mcp_bundles (id, name, token_hash, default_operations)
			VALUES (${randomUUID()}, ${name}, ${tokenHash}, ${defaultOperations}::jsonb)
			ON CONFLICT (name) DO NOTHING
			RETURNING id, name, token_hash, default_operations`;
		if (inserted[0]) return { bundle: toBundle(inserted[0]), created: true };
		const existing = await this.bundleByName(name);
		if (!existing) throw new Error(`bundle ${name} vanished`);
		return { bundle: existing, created: false };
	}

	async rotateToken(bundleId: string, tokenHash: string): Promise<void> {
		await this.#sql.begin(async (tx) => {
			const rows = await tx`
				UPDATE discord_mcp_bundles SET token_hash = ${tokenHash} WHERE id = ${bundleId}
				RETURNING id`;
			if (rows.length === 0) throw new Error(`bundle ${bundleId} not found`);
			await tx`
				INSERT INTO discord_channel_audit (id, bundle_id, channel_id, tool, status)
				VALUES (${randomUUID()}, ${bundleId}, '-', 'rotate_token', 'succeeded')`;
		});
	}

	/** Every grant, or one bundle's. */
	async grants(bundleId?: string): Promise<ChannelGrant[]> {
		const rows: GrantRow[] = await this.#sql`
			SELECT * FROM discord_channel_grants
			WHERE ${bundleId ?? null}::uuid IS NULL OR bundle_id = ${bundleId ?? null}::uuid
			ORDER BY bundle_id, channel_id`;
		return rows.map(toGrant);
	}

	async grant(
		bundleId: string,
		channelId: string,
	): Promise<ChannelGrant | undefined> {
		const rows: GrantRow[] = await this.#sql`
			SELECT * FROM discord_channel_grants
			WHERE bundle_id = ${bundleId} AND channel_id = ${channelId}`;
		return rows[0] && toGrant(rows[0]);
	}

	/** Adds the channel to the bundle, or replaces its grant there. */
	async save(grant: ChannelGrant): Promise<void> {
		await this.#sql.begin(async (tx) => {
			await tx`
				INSERT INTO discord_channel_grants (bundle_id, channel_id, guild_id, operations,
					display_name, description, guild_name, channel_name, authorized_by, authorized_at)
				VALUES (${grant.bundleId}, ${grant.channelId}, ${grant.guildId}, ${grant.operations}::jsonb,
					${grant.displayName}, ${grant.description}, ${grant.guildName}, ${grant.channelName},
					${grant.authorizedBy}, ${grant.authorizedAt})
				ON CONFLICT (bundle_id, channel_id) DO UPDATE SET
					guild_id = EXCLUDED.guild_id, operations = EXCLUDED.operations,
					display_name = EXCLUDED.display_name, description = EXCLUDED.description,
					guild_name = EXCLUDED.guild_name, channel_name = EXCLUDED.channel_name,
					authorized_by = EXCLUDED.authorized_by, authorized_at = EXCLUDED.authorized_at`;
			await tx`
				INSERT INTO discord_channel_audit (id, bundle_id, channel_id, guild_id, tool, status)
				VALUES (${randomUUID()}, ${grant.bundleId}, ${grant.channelId}, ${grant.guildId},
					'authorize', 'succeeded')`;
		});
	}

	/** Resolves false when the channel was not in the bundle. */
	async revoke(bundleId: string, channelId: string): Promise<boolean> {
		return this.#sql.begin(async (tx) => {
			const rows = await tx`
				DELETE FROM discord_channel_grants WHERE bundle_id = ${bundleId} AND channel_id = ${channelId}
				RETURNING channel_id`;
			if (rows.length === 0) return false;
			await tx`
				INSERT INTO discord_channel_audit (id, bundle_id, channel_id, tool, status)
				VALUES (${randomUUID()}, ${bundleId}, ${channelId}, 'revoke', 'succeeded')`;
			return true;
		});
	}

	/** Changes what an agent is told about the channel; resolves false when it is not granted. */
	async describe(
		bundleId: string,
		channelId: string,
		change: { displayName?: string; description?: string },
	): Promise<boolean> {
		const rows = await this.#sql`
			UPDATE discord_channel_grants SET
				display_name = COALESCE(${change.displayName ?? null}, display_name),
				description = COALESCE(${change.description ?? null}, description)
			WHERE bundle_id = ${bundleId} AND channel_id = ${channelId}
			RETURNING channel_id`;
		return rows.length > 0;
	}

	async recentAudit(channelId: string, limit = 10): Promise<ChannelAudit[]> {
		const rows: { tool: string; status: string; created_at: Date }[] =
			await this.#sql`
			SELECT tool, status, created_at FROM discord_channel_audit
			WHERE channel_id = ${channelId} ORDER BY created_at DESC LIMIT ${limit}`;
		return rows.map((row) => ({
			tool: row.tool,
			status: row.status,
			createdAt: row.created_at,
		}));
	}

	/** Records a tool call before it runs; returns the receipt to finish. */
	async startCall(
		bundleId: string,
		guildId: string,
		tool: string,
		args: Record<string, unknown>,
	): Promise<string> {
		const id = randomUUID();
		const digest = createHash("sha256")
			.update(JSON.stringify(args))
			.digest("hex");
		await this.#sql`
			INSERT INTO discord_channel_audit (id, bundle_id, channel_id, guild_id, tool, arguments_digest, status)
			VALUES (${id}, ${bundleId}, ${String(args.channelId)}, ${guildId}, ${tool}, ${digest}, 'started')`;
		return id;
	}

	async finishCall(
		receipt: string,
		status: "succeeded" | "failed",
	): Promise<void> {
		await this
			.#sql`UPDATE discord_channel_audit SET status = ${status} WHERE id = ${receipt}`;
	}
}
