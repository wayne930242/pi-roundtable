import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentError } from "../../domain/errors.ts";
import type { SkillRegistry } from "../../services.ts";
import { planLinkedSkills } from "./skill-link.ts";
import { skillCatalog, skillListText } from "./skill-listing.ts";
import {
	BUILTIN_SKILLS,
	checkBody,
	checkDescription,
	checkSkillName,
	type ResolvedSkill,
	readSkillFile,
	type SkillCatalogEntry,
	type SkillRegistryOptions,
	type SkillSet,
	skillFileContent,
} from "./skill-rules.ts";
import type { SkillEntry } from "./skill-store.ts";

export {
	BUILTIN_SKILLS,
	checkSkillName,
	MAX_SKILL_BODY_CHARS,
	type ResolvedSkill,
	type SkillCatalogEntry,
	type SkillRegistryOptions,
	type SkillSet,
	type SkillSource,
} from "./skill-rules.ts";

/** The skill registry and what each agent carries. */
export class StoredSkillRegistry implements SkillRegistry {
	readonly #options: SkillRegistryOptions;

	constructor(options: SkillRegistryOptions) {
		this.#options = options;
	}

	/** Writes every agent-written skill for Pi and removes folders left by deleted ones. */
	init(): void {
		const { store, writtenDir } = this.#options;
		mkdirSync(writtenDir, { recursive: true });
		const written = new Set<string>();
		for (const entry of store.skills()) {
			if (entry.kind !== "written") continue;
			this.#write(entry);
			written.add(entry.name);
		}
		for (const name of readdirSync(writtenDir))
			if (!written.has(name))
				rmSync(join(writtenDir, name), { recursive: true, force: true });
	}

	// ── Reading ────────────────────────────────────────────────────────────

	/** The resolved built-in skills plus the named registered ones. */
	resolve(names: readonly string[]): SkillSet {
		const set: SkillSet = { skills: [], missing: [] };
		for (const name of new Set([...BUILTIN_SKILLS, ...names])) {
			const one = this.#resolveOne(name);
			if ("reason" in one) set.missing.push(one);
			else set.skills.push(one);
		}
		return set;
	}

	/** What an agent carries, built-in skills included. */
	carried(agent: string): SkillSet {
		const set = this.resolve(this.#options.store.carriedBy(agent));
		for (const { name, reason } of set.missing)
			this.#options.logger.warn(
				{ agent, skill: name, reason },
				"carried skill missing",
			);
		return set;
	}

	/** The skills linked from a managed repository, as repo_list shows them. */
	linkedFrom(repo: string): string[] {
		return this.#options.store
			.skills()
			.flatMap((entry) =>
				entry.kind === "linked" && entry.repo === repo ? [entry.name] : [],
			);
	}

	/** The registered skills an agent carries, as the dashboard lists them. */
	carriedNames(agent: string): string[] {
		return this.#options.store.carriedBy(agent);
	}

	/** An agent's skills as agent_get shows them (behavior 19). */
	describeCarried(agent: string): string {
		const set = this.resolve(this.#options.store.carriedBy(agent));
		const lines = set.skills.map((skill) =>
			(BUILTIN_SKILLS as readonly string[]).includes(skill.name)
				? `${skill.name} (built in)`
				: skill.name,
		);
		for (const { name, reason } of set.missing)
			lines.push(`${name} (missing: ${reason})`);
		return lines.join(", ");
	}

	/** Every skill, built-in ones first, with what `list` shows as text (web app spec behavior 15). */
	catalog(): SkillCatalogEntry[] {
		return skillCatalog(this.#options.store, (name) => this.#resolveOne(name));
	}

	/** Every skill, or those of a group or matching a query (behavior 14). */
	list(filter: { group?: string; query?: string } = {}): string {
		return skillListText(
			this.#options.store,
			(name) => this.#resolveOne(name),
			filter,
		);
	}

	/** Throws when a name is not registered; built-in names are carried already. */
	checkRegistered(names: readonly string[]): void {
		const unknown = names.filter((name) => !this.#options.store.skill(name));
		if (unknown.length > 0)
			throw new AgentError(
				`Unknown skills: ${unknown.join(", ")}. Find names with skill_list.${unknown.some((n) => (BUILTIN_SKILLS as readonly string[]).includes(n)) ? " Built-in skills are always carried." : ""}`,
			);
	}

	// ── Changing ───────────────────────────────────────────────────────────

	/** Links the skill at a repository path, or every child folder with a SKILL.md (behavior 15). */
	async link(repo: string, path: string): Promise<string> {
		const entries = planLinkedSkills(
			this.#options.reposDir,
			repo,
			path,
			(name) => this.#checkFreeName(name),
		);
		await this.#options.store.addLinked(entries);
		const names = entries.map((e) => e.name);
		return `Linked ${entries.length} skill${entries.length === 1 ? "" : "s"} from ${repo}: ${names.join(", ")}. Attach them with agent_skills.`;
	}

	async unlink(name: string): Promise<string> {
		const entry = this.#entry(name);
		if (entry.kind !== "linked")
			throw new AgentError(
				`${name} is written by an agent; remove it with skill_delete.`,
			);
		return this.#removed(name, await this.#options.store.remove(name));
	}

	async create(skill: {
		name: string;
		description: string;
		body: string;
	}): Promise<string> {
		checkSkillName(skill.name);
		this.#checkFreeName(skill.name);
		checkDescription(skill.description);
		checkBody(skill.body);
		const entry = {
			name: skill.name,
			description: skill.description.trim(),
			body: skill.body.trim(),
		};
		await this.#options.store.addWritten(entry);
		this.#write(entry);
		return `Created skill ${skill.name}. Attach it with agent_skills; it loads from each carrier's next turn.`;
	}

	async update(
		name: string,
		change: { description?: string; body?: string },
	): Promise<string> {
		const entry = this.#writable(name);
		if (change.description !== undefined) checkDescription(change.description);
		if (change.body !== undefined) checkBody(change.body);
		const next = {
			name,
			description: change.description?.trim() ?? entry.description,
			body: change.body?.trim() ?? entry.body,
		};
		await this.#options.store.updateWritten(next);
		this.#write(next);
		return `Updated skill ${name}; its carriers read the new version from their next turn.`;
	}

	async delete(name: string): Promise<string> {
		this.#writable(name);
		const detached = await this.#options.store.remove(name);
		rmSync(join(this.#options.writtenDir, name), {
			recursive: true,
			force: true,
		});
		return this.#removed(name, detached);
	}

	async setGroup(
		name: string,
		description: string,
		skills: readonly string[],
	): Promise<string> {
		checkSkillName(name);
		if (!description.trim())
			throw new AgentError("A skill group needs a description.");
		const unknown = skills.filter(
			(skill) =>
				!this.#options.store.skill(skill) &&
				!(BUILTIN_SKILLS as readonly string[]).includes(skill),
		);
		if (unknown.length > 0)
			throw new AgentError(
				`Unknown skills: ${unknown.join(", ")}. Nothing was changed.`,
			);
		const existed = this.#options.store.group(name) !== undefined;
		await this.#options.store.setGroup({
			name,
			description: description.trim(),
			skills: [...new Set(skills)],
		});
		return `${existed ? "Replaced" : "Created"} skill group ${name}: ${[...new Set(skills)].join(", ") || "empty"}.`;
	}

	async deleteGroup(name: string): Promise<string> {
		if (!this.#options.store.group(name))
			throw new AgentError(`There is no skill group "${name}".`);
		await this.#options.store.removeGroup(name);
		return `Deleted skill group ${name}; its skills are untouched.`;
	}

	/** Adds and removes an agent's skills together, or changes nothing (behavior 19). */
	async attach(
		agent: string,
		add: readonly string[],
		remove: readonly string[],
	): Promise<string[]> {
		const builtin = remove.filter((name) =>
			(BUILTIN_SKILLS as readonly string[]).includes(name),
		);
		if (builtin.length > 0)
			throw new AgentError(
				`${builtin.join(", ")} is built in and stays with every agent. Nothing was changed.`,
			);
		this.checkRegistered(add);
		const current = this.#options.store.carriedBy(agent);
		const next = [...new Set([...current, ...add])].filter(
			(name) => !remove.includes(name),
		);
		await this.#options.store.setCarried(agent, next);
		return this.#options.store.carriedBy(agent);
	}

	// ── Internals ──────────────────────────────────────────────────────────

	#resolveOne(name: string): ResolvedSkill | { name: string; reason: string } {
		const file = this.#fileOf(name);
		if (!file) return { name, reason: "not registered" };
		const read = readSkillFile(file);
		if ("error" in read) return { name, reason: read.error };
		if (read.name !== name)
			return {
				name,
				reason: `its file is now named "${read.name}"; unlink it and link it again`,
			};
		return { name, description: read.description, file };
	}

	#fileOf(name: string): string | undefined {
		const { store, reposDir, writtenDir, builtinDir } = this.#options;
		if ((BUILTIN_SKILLS as readonly string[]).includes(name))
			return join(builtinDir, name, "SKILL.md");
		const entry = store.skill(name);
		if (!entry) return undefined;
		return entry.kind === "linked"
			? join(reposDir, entry.repo, entry.path, "SKILL.md")
			: join(writtenDir, name, "SKILL.md");
	}

	#entry(name: string): SkillEntry {
		const entry = this.#options.store.skill(name);
		if (!entry)
			throw new AgentError(
				(BUILTIN_SKILLS as readonly string[]).includes(name)
					? `${name} is built in and cannot be changed.`
					: `There is no skill "${name}"; see skill_list.`,
			);
		return entry;
	}

	#writable(name: string): Extract<SkillEntry, { kind: "written" }> {
		const entry = this.#entry(name);
		if (entry.kind !== "written")
			throw new AgentError(
				`${name} is linked from ${entry.repo}:${entry.path} and is read-only here. Change it in the repository with repo_task, then ship it with repo_change_report and repo_push.`,
			);
		return entry;
	}

	#checkFreeName(name: string): void {
		if (
			(BUILTIN_SKILLS as readonly string[]).includes(name) ||
			this.#options.store.skill(name)
		)
			throw new AgentError(`A skill named "${name}" already exists.`);
	}

	#write(entry: { name: string; description: string; body: string }): void {
		const dir = join(this.#options.writtenDir, entry.name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), skillFileContent(entry));
	}

	#removed(name: string, detached: { agents: string[]; groups: string[] }) {
		const from = [
			detached.agents.length > 0
				? `agents ${detached.agents.join(", ")}`
				: undefined,
			detached.groups.length > 0
				? `groups ${detached.groups.join(", ")}`
				: undefined,
		].filter(Boolean);
		return `Removed skill ${name}${from.length > 0 ? `; detached from ${from.join(" and ")}` : ""}.`;
	}
}
