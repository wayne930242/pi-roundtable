import { randomBytes } from "node:crypto";
import type { SQL } from "bun";
import type { ChannelKey, Migration } from "pi-roundtable";

/** A one-time request to add a connector, as an agent made it: never a URL or a token. */
export interface StoredAddRequest {
	id: string;
	name: string;
	description: string;
	/** The conversation that asked, which hears how the add went. */
	conversation: ChannelKey;
	requestedBy: string;
	expiresAt: Date;
}

interface Row {
	id: string;
	name: string;
	description: string;
	conversation: string;
	requested_by: string;
	expires_at: Date;
}

const stored = (row: Row): StoredAddRequest => ({
	id: row.id,
	name: row.name,
	description: row.description,
	conversation: row.conversation as ChannelKey,
	requestedBy: row.requested_by,
	expiresAt: new Date(row.expires_at),
});

/**
 * The connector add requests, in `web_connector_add_requests`. A request is live until it is used
 * once or its expiry passes; the table has no column for a URL, so none can be kept.
 */
export class ConnectorAddRequestStore {
	readonly #sql: SQL;

	constructor(sql: SQL) {
		this.#sql = sql;
	}

	static readonly migration: Migration = {
		name: "web-connector-add-requests",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS web_connector_add_requests (
					id text PRIMARY KEY,
					name text NOT NULL,
					description text NOT NULL,
					conversation text NOT NULL,
					requested_by text NOT NULL,
					created_at timestamptz NOT NULL DEFAULT now(),
					expires_at timestamptz NOT NULL,
					used_at timestamptz
				)`;
		},
	};

	async create(request: Omit<StoredAddRequest, "id">): Promise<string> {
		const id = randomBytes(18).toString("base64url");
		await this.#sql`
			INSERT INTO web_connector_add_requests (id, name, description, conversation, requested_by, expires_at)
			VALUES (${id}, ${request.name}, ${request.description}, ${request.conversation},
				${request.requestedBy}, ${request.expiresAt})`;
		return id;
	}

	/** The live request of this id; undefined for an unknown, used or expired one alike. */
	async live(id: string): Promise<StoredAddRequest | undefined> {
		const [row]: Row[] = await this.#sql`
			SELECT * FROM web_connector_add_requests
			WHERE id = ${id} AND used_at IS NULL AND expires_at > now()`;
		return row ? stored(row) : undefined;
	}

	/** Marks the live request used and returns it; undefined when there is none, as when two submissions race. */
	async claim(id: string): Promise<StoredAddRequest | undefined> {
		const [row]: Row[] = await this.#sql`
			UPDATE web_connector_add_requests SET used_at = now()
			WHERE id = ${id} AND used_at IS NULL AND expires_at > now()
			RETURNING *`;
		// Requests a day past their expiry are of no further use.
		await this.#sql`
			DELETE FROM web_connector_add_requests WHERE expires_at < now() - interval '1 day'`;
		return row ? stored(row) : undefined;
	}
}
