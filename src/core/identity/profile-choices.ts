import type { SQL } from "bun";

/**
 * Which linked account represents each person, the one thing about profiles that is stored. A
 * name or a picture address is never written to a table.
 */
export class ProfileChoices {
	readonly #sql: SQL;

	constructor(sql: SQL) {
		this.#sql = sql;
	}

	async get(principalId: string): Promise<string | undefined> {
		const rows: { provider: string }[] = await this.#sql`
			SELECT provider FROM principal_profile_choices WHERE principal_id = ${principalId}`;
		return rows[0]?.provider;
	}

	async set(principalId: string, provider: string): Promise<void> {
		await this.#sql`
			INSERT INTO principal_profile_choices (principal_id, provider, chosen_at)
			VALUES (${principalId}, ${provider}, now())
			ON CONFLICT (principal_id)
			DO UPDATE SET provider = EXCLUDED.provider, chosen_at = EXCLUDED.chosen_at`;
	}

	async clear(principalId: string): Promise<void> {
		await this.#sql`
			DELETE FROM principal_profile_choices WHERE principal_id = ${principalId}`;
	}
}

/**
 * The provider a principal chose, read for the CLI beside a host that may not have made the table
 * yet; undefined for no choice or no table.
 */
export async function chosenProfileSource(
	sql: SQL,
	principalId: string,
): Promise<string | undefined> {
	const [table] = await sql`
		SELECT to_regclass('principal_profile_choices') IS NOT NULL AS made`;
	return table?.made ? new ProfileChoices(sql).get(principalId) : undefined;
}
