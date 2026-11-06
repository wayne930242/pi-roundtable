import type { SQL } from "bun";
import type { CharacterInput } from "../../characters/index.ts";
import { AgentError } from "../domain/errors.ts";

/** The most presets one agent may keep. */
export const MAX_HELPER_PRESETS = 20;

/** A temp knight an agent makes often: what `helper_create` takes, saved under a name. */
export interface HelperPreset {
	name: string;
	displayName: string;
	prompt: string;
	skills: string[];
	character?: CharacterInput;
	model?: string;
	thinking?: string;
}

/** Who besides its saving agent may recruit from a preset: every knight, or the ones named. */
export type PresetSharing = "all" | string[];

/** A preset as its saving agent and the owners see it: with whom it is shared, absent for none. */
export interface OwnedPreset extends HelperPreset {
	sharedWith?: PresetSharing;
}

/** A preset another knight may recruit from, with the agent that saved it. */
export interface UsablePreset extends OwnedPreset {
	agent: string;
}

interface Row {
	agent: string;
	name: string;
	display_name: string;
	prompt: string;
	skills: string[] | null;
	character: CharacterInput | null;
	model: string | null;
	thinking: string | null;
	shared_with: string[] | null;
}

const toPreset = (row: Row): UsablePreset => ({
	agent: row.agent,
	name: row.name,
	displayName: row.display_name,
	prompt: row.prompt,
	skills: row.skills ?? [],
	...(row.character ? { character: row.character } : {}),
	...(row.model ? { model: row.model } : {}),
	...(row.thinking ? { thinking: row.thinking } : {}),
	...(row.shared_with
		? {
				sharedWith: row.shared_with.includes("*")
					? ("all" as const)
					: row.shared_with,
			}
		: {}),
});

const owned = ({ agent: _agent, ...preset }: UsablePreset): OwnedPreset =>
	preset;

/**
 * The temp-knight presets, each owned by the agent that saved it: only it and the owners change
 * one, and others recruit from it only when it is shared with them. They outlive an archive, so an
 * agent restored finds its presets.
 */
export class HelperPresets {
	readonly #sql: SQL;
	readonly #guild: string;

	constructor(sql: SQL, guildId: string) {
		this.#sql = sql;
		this.#guild = guildId;
	}

	/** The table, created by the agents' migrations. */
	static readonly migration = {
		name: "helper-presets",
		up: async (sql: SQL) => {
			await sql`
				CREATE TABLE IF NOT EXISTS helper_presets (
					guild_id text NOT NULL,
					agent text NOT NULL,
					name text NOT NULL,
					display_name text NOT NULL,
					prompt text NOT NULL,
					skills jsonb NOT NULL DEFAULT '[]',
					character jsonb,
					model text,
					thinking text,
					updated_at timestamptz NOT NULL DEFAULT now(),
					PRIMARY KEY (guild_id, agent, name)
				)`;
		},
	};

	/** Who may recruit from a preset besides its agent: `NULL` none, `["*"]` every knight. */
	static readonly sharingMigration = {
		name: "helper-presets-shared",
		up: async (sql: SQL) => {
			await sql`ALTER TABLE helper_presets ADD COLUMN IF NOT EXISTS shared_with jsonb`;
		},
	};

	/** The agent's presets, by name. */
	async list(agent: string): Promise<OwnedPreset[]> {
		const rows: Row[] = await this.#sql`
			SELECT * FROM helper_presets
			WHERE guild_id = ${this.#guild} AND agent = ${agent} ORDER BY name`;
		return rows.map((row) => owned(toPreset(row)));
	}

	/** The presets other agents share with this one, by their agent and then name. */
	async sharedWith(agent: string): Promise<UsablePreset[]> {
		const rows: Row[] = await this.#sql`
			SELECT * FROM helper_presets
			WHERE guild_id = ${this.#guild} AND agent <> ${agent}
				AND (shared_with @> '["*"]'::jsonb
					OR shared_with @> jsonb_build_array(${agent}::text))
			ORDER BY agent, name`;
		return rows.map(toPreset);
	}

	async get(agent: string, name: string): Promise<OwnedPreset | undefined> {
		const rows: Row[] = await this.#sql`
			SELECT * FROM helper_presets
			WHERE guild_id = ${this.#guild} AND agent = ${agent} AND name = ${name}`;
		return rows[0] ? owned(toPreset(rows[0])) : undefined;
	}

	/**
	 * Saves the preset whole, refusing a new one past the cap; says whether it was new. `sharing`
	 * left out keeps a replaced preset's and shares a new one with none.
	 */
	async set(
		agent: string,
		preset: HelperPreset,
		sharing?: PresetSharing | null,
	): Promise<"created" | "replaced"> {
		const shared = sharing === "all" ? ["*"] : sharing?.length ? sharing : null;
		const keep = sharing === undefined;
		const guild = this.#guild;
		return this.#sql.begin(async (tx) => {
			// One save per agent at a time, so two cannot both pass the cap.
			await tx`SELECT pg_advisory_xact_lock(hashtext(${`helper-presets:${guild}:${agent}`}))`;
			const [counted]: { others: number; same: number }[] = await tx`
				SELECT count(*) FILTER (WHERE name <> ${preset.name})::int AS others,
					count(*) FILTER (WHERE name = ${preset.name})::int AS same
				FROM helper_presets WHERE guild_id = ${guild} AND agent = ${agent}`;
			const replaced = (counted?.same ?? 0) > 0;
			if (!replaced && (counted?.others ?? 0) >= MAX_HELPER_PRESETS)
				throw new AgentError(
					`You have ${MAX_HELPER_PRESETS} presets, the most you may keep; delete one with helper_preset_delete or replace one by saving under its name.`,
				);
			await tx`
				INSERT INTO helper_presets
					(guild_id, agent, name, display_name, prompt, skills, character, model, thinking,
					shared_with)
				VALUES (${guild}, ${agent}, ${preset.name}, ${preset.displayName}, ${preset.prompt},
					${preset.skills}::jsonb, ${preset.character ?? null}::jsonb,
					${preset.model ?? null}, ${preset.thinking ?? null}, ${shared}::jsonb)
				ON CONFLICT (guild_id, agent, name) DO UPDATE SET
					display_name = EXCLUDED.display_name, prompt = EXCLUDED.prompt,
					skills = EXCLUDED.skills, character = EXCLUDED.character,
					model = EXCLUDED.model, thinking = EXCLUDED.thinking, updated_at = now(),
					shared_with = CASE WHEN ${keep} THEN helper_presets.shared_with
						ELSE EXCLUDED.shared_with END`;
			return replaced ? "replaced" : "created";
		});
	}

	/** Deletes one of the agent's presets; says whether there was one. */
	async delete(agent: string, name: string): Promise<boolean> {
		const rows = await this.#sql`
			DELETE FROM helper_presets
			WHERE guild_id = ${this.#guild} AND agent = ${agent} AND name = ${name}
			RETURNING name`;
		return rows.length > 0;
	}
}
