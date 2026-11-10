import type { SQL } from "bun";
import type { Migration } from "pi-roundtable";
import {
	type CharacterInput,
	type CharacterSpec,
	readCharacter,
	resolveCharacter,
	suggestCharacter,
} from "pi-roundtable/characters";
import { storedJson } from "../host/stored-json.ts";

/**
 * The knights people made for themselves, in `web_person_characters`: one look per principal, drawn
 * where the app shows the person. A person without a row is shown by their account picture.
 */
export class PersonCharacters {
	readonly #sql: SQL;

	constructor(sql: SQL) {
		this.#sql = sql;
	}

	static readonly migration: Migration = {
		name: "web-person-characters",
		up: async (sql) => {
			// No foreign key, as in `web_push_prefs`: a principal is disabled, never deleted.
			await sql`
				CREATE TABLE IF NOT EXISTS web_person_characters (
					principal_id text PRIMARY KEY,
					character jsonb NOT NULL,
					updated_at timestamptz NOT NULL DEFAULT now()
				)`;
		},
	};

	/** The person's knight; none when they made none, or when the kit no longer takes the stored one. */
	async of(principalId: string): Promise<CharacterSpec | undefined> {
		const [row]: { character: unknown }[] = await this.#sql`
			SELECT character FROM web_person_characters
			WHERE principal_id = ${principalId}`;
		if (!row) return undefined;
		return readCharacter(storedJson(row.character, "person's character"));
	}

	/**
	 * Dresses the person: the input's fields over their stored knight, or over the look their id
	 * suggests when they have none. A refused field throws a `CharacterError` and stores nothing.
	 */
	async dress(
		person: { principalId: string; name: string },
		input: CharacterInput,
	): Promise<CharacterSpec> {
		const base =
			(await this.of(person.principalId)) ??
			suggestCharacter({
				name: person.principalId,
				displayName: person.name,
				prompt: "",
			});
		const spec = resolveCharacter(input, base);
		await this.#sql`
			INSERT INTO web_person_characters (principal_id, character)
			VALUES (${person.principalId}, ${JSON.stringify(spec)}::text::jsonb)
			ON CONFLICT (principal_id) DO UPDATE
			SET character = EXCLUDED.character, updated_at = now()`;
		return spec;
	}

	/** Takes the person's knight away; their account picture shows again. */
	async remove(principalId: string): Promise<void> {
		await this.#sql`
			DELETE FROM web_person_characters WHERE principal_id = ${principalId}`;
	}
}
