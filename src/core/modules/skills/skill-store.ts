import type { SQL } from "bun";
import { scopeToGuild } from "../../db/guild-scope.ts";
import type { Migration } from "../../db/migrations.ts";
import { AgentError } from "../../domain/errors.ts";

/**
 * A registered skill. A linked skill's name and description
 * live in its repository's file; an agent-written one keeps them here.
 */
export type SkillEntry =
	| { kind: "linked"; name: string; repo: string; path: string }
	| { kind: "written"; name: string; description: string; body: string };

export interface SkillGroup {
	name: string;
	description: string;
	skills: string[];
}

/** Who lost a removed skill. */
export interface Detached {
	agents: string[];
	groups: string[];
}

interface SkillRow {
	name: string;
	kind: "linked" | "written";
	repo: string | null;
	path: string | null;
	description: string | null;
	body: string | null;
}

interface GroupRow {
	name: string;
	description: string;
	skills: string;
}

const toEntry = (row: SkillRow): SkillEntry =>
	row.kind === "linked"
		? {
				kind: "linked",
				name: row.name,
				repo: row.repo ?? "",
				path: row.path ?? "",
			}
		: {
				kind: "written",
				name: row.name,
				description: row.description ?? "",
				body: row.body ?? "",
			};

const toGroup = (row: GroupRow): SkillGroup => ({
	name: row.name,
	description: row.description,
	skills: row.skills.split(",").filter(Boolean),
});

/**
 * Skills, skill groups, and the skills each agent carries, in the database. All of it is
 * also held in memory, because every agent turn resolves its skills and only this process
 * changes them.
 */
export class SkillStore {
	readonly #sql: SQL;
	readonly #skills = new Map<string, SkillEntry>();
	readonly #groups = new Map<string, SkillGroup>();
	readonly #carried = new Map<string, string[]>();

	readonly #guild: string;

	private constructor(sql: SQL, guildId: string) {
		this.#sql = sql;
		this.#guild = guildId;
	}

	/** The store's tables; the host runs this before any store attaches. */
	static readonly migration: Migration = {
		name: "skills",
		up: async (sql) => {
			await sql`
				CREATE TABLE IF NOT EXISTS skills (
					name text PRIMARY KEY,
					kind text NOT NULL,
					repo text,
					path text,
					description text,
					body text,
					created_at timestamptz NOT NULL DEFAULT now(),
					updated_at timestamptz NOT NULL DEFAULT now()
				)`;
			await sql`
				CREATE TABLE IF NOT EXISTS skill_groups (
					name text PRIMARY KEY,
					description text NOT NULL,
					-- Comma-separated skill names, which never contain a comma.
					skills text NOT NULL
				)`;
			await sql`
				CREATE TABLE IF NOT EXISTS agent_skills (
					agent text NOT NULL,
					skill text NOT NULL,
					PRIMARY KEY (agent, skill)
				)`;
		},
	};

	/**
	 * The store's tables, then the guild of each agent's skills, existing rows given `guildId`.
	 * The skill catalog itself is shared by every guild.
	 */
	static migrations(guildId: string): Migration[] {
		return [
			SkillStore.migration,
			{
				name: "skills-guild",
				up: (sql) =>
					scopeToGuild(sql, guildId, [
						{ table: "agent_skills", key: ["agent", "skill"] },
					]),
			},
		];
	}

	/** The store over the host's migrated pool; the skills agents carry are those of one guild. */
	static async attach(sql: SQL, guildId: string): Promise<SkillStore> {
		const store = new SkillStore(sql, guildId);
		await store.#reload();
		return store;
	}

	async #reload(): Promise<void> {
		const skills: SkillRow[] = await this.#sql`SELECT * FROM skills`;
		const groups: GroupRow[] = await this.#sql`SELECT * FROM skill_groups`;
		const carried: { agent: string; skill: string }[] = await this
			.#sql`SELECT agent, skill FROM agent_skills
			WHERE guild_id = ${this.#guild} ORDER BY agent, skill`;
		this.#skills.clear();
		this.#groups.clear();
		this.#carried.clear();
		for (const row of skills) this.#skills.set(row.name, toEntry(row));
		for (const row of groups) this.#groups.set(row.name, toGroup(row));
		for (const row of carried)
			this.#carried.set(row.agent, [
				...(this.#carried.get(row.agent) ?? []),
				row.skill,
			]);
	}

	skills(): SkillEntry[] {
		return [...this.#skills.values()].sort((a, b) =>
			a.name.localeCompare(b.name),
		);
	}

	skill(name: string): SkillEntry | undefined {
		return this.#skills.get(name);
	}

	groups(): SkillGroup[] {
		return [...this.#groups.values()].sort((a, b) =>
			a.name.localeCompare(b.name),
		);
	}

	group(name: string): SkillGroup | undefined {
		return this.#groups.get(name);
	}

	/** The registered skills an agent carries, by name. */
	carriedBy(agent: string): string[] {
		return this.#carried.get(agent) ?? [];
	}

	/** The agents carrying a skill. */
	carriers(skill: string): string[] {
		return [...this.#carried]
			.filter(([, skills]) => skills.includes(skill))
			.map(([agent]) => agent)
			.sort();
	}

	/** Registers linked skills together, or none when any name is taken. */
	async addLinked(
		entries: readonly { name: string; repo: string; path: string }[],
	): Promise<void> {
		const taken = entries.filter((entry) => this.#skills.has(entry.name));
		if (taken.length > 0)
			throw new AgentError(
				`Already registered: ${taken.map((entry) => entry.name).join(", ")}. Nothing was linked.`,
			);
		await this.#sql.begin(async (tx) => {
			for (const entry of entries)
				await tx`
					INSERT INTO skills (name, kind, repo, path)
					VALUES (${entry.name}, 'linked', ${entry.repo}, ${entry.path})`;
		});
		for (const entry of entries)
			this.#skills.set(entry.name, { kind: "linked", ...entry });
	}

	async addWritten(skill: {
		name: string;
		description: string;
		body: string;
	}): Promise<void> {
		if (this.#skills.has(skill.name))
			throw new AgentError(`A skill named "${skill.name}" already exists.`);
		await this.#sql`
			INSERT INTO skills (name, kind, description, body)
			VALUES (${skill.name}, 'written', ${skill.description}, ${skill.body})`;
		this.#skills.set(skill.name, { kind: "written", ...skill });
	}

	async updateWritten(skill: {
		name: string;
		description: string;
		body: string;
	}): Promise<void> {
		await this.#sql`
			UPDATE skills SET description = ${skill.description}, body = ${skill.body},
				updated_at = now()
			WHERE name = ${skill.name} AND kind = 'written'`;
		this.#skills.set(skill.name, { kind: "written", ...skill });
	}

	/** Removes a skill and detaches it from every agent and group. */
	async remove(name: string): Promise<Detached> {
		const agents = this.carriers(name);
		const groups = this.groups().filter((group) => group.skills.includes(name));
		await this.#sql.begin(async (tx) => {
			await tx`DELETE FROM skills WHERE name = ${name}`;
			await tx`DELETE FROM agent_skills WHERE guild_id = ${this.#guild} AND skill = ${name}`;
			for (const group of groups)
				await tx`
					UPDATE skill_groups
					SET skills = ${group.skills.filter((s) => s !== name).join(",")}
					WHERE name = ${group.name}`;
		});
		await this.#reload();
		return { agents, groups: groups.map((group) => group.name) };
	}

	async setGroup(group: SkillGroup): Promise<void> {
		await this.#sql`
			INSERT INTO skill_groups (name, description, skills)
			VALUES (${group.name}, ${group.description}, ${group.skills.join(",")})
			ON CONFLICT (name) DO UPDATE
			SET description = EXCLUDED.description, skills = EXCLUDED.skills`;
		this.#groups.set(group.name, { ...group, skills: [...group.skills] });
	}

	async removeGroup(name: string): Promise<void> {
		await this.#sql`DELETE FROM skill_groups WHERE name = ${name}`;
		this.#groups.delete(name);
	}

	/** Replaces the registered skills an agent carries. */
	async setCarried(agent: string, skills: readonly string[]): Promise<void> {
		const sorted = [...new Set(skills)].sort();
		await this.#sql.begin(async (tx) => {
			await tx`DELETE FROM agent_skills WHERE guild_id = ${this.#guild} AND agent = ${agent}`;
			for (const skill of sorted)
				await tx`INSERT INTO agent_skills (guild_id, agent, skill) VALUES (${this.#guild}, ${agent}, ${skill})`;
		});
		if (sorted.length > 0) this.#carried.set(agent, sorted);
		else this.#carried.delete(agent);
	}
}
