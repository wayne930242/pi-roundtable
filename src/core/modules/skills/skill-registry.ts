import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { AgentError } from "../../domain/errors.ts";
import { PluginError } from "../../errors.ts";
import type { SkillRegistry } from "../../services.ts";
import { planLinkedSkills } from "./skill-link.ts";
import { skillCatalog, skillListText } from "./skill-listing.ts";
import {
	BUILTIN_SKILLS,
	checkBody,
	checkDescription,
	checkSkillName,
	hashOf,
	MAX_DOCUMENT_BYTES,
	type PackageSkill,
	parseSkillDocument,
	type ResolvedSkill,
	readSkillFile,
	type SkillCatalogEntry,
	SkillConflictError,
	type SkillDocument,
	type SkillRegistryOptions,
	type SkillSet,
	type SkillSource,
	type SkillVersion,
	skillFileContent,
} from "./skill-rules.ts";
import type { SkillEntry } from "./skill-store.ts";

export {
	BUILTIN_SKILLS,
	checkSkillName,
	MAX_SKILL_BODY_CHARS,
	type PackageSkill,
	type ResolvedSkill,
	type SkillCatalogEntry,
	SkillConflictError,
	type SkillDocument,
	type SkillRegistryOptions,
	type SkillSet,
	type SkillSource,
	type SkillVersion,
} from "./skill-rules.ts";

/** The skill registry and what each agent carries. */
export class StoredSkillRegistry implements SkillRegistry {
	readonly #options: SkillRegistryOptions;
	readonly #packageSkills = new Map<string, PackageSkill>();
	/** The tail of the document writes, so a hash is checked and the skill written without another save between. */
	#documents: Promise<unknown> = Promise.resolve();

	/** Throws a PluginError when a package skill has the name of a linked or written one. */
	constructor(options: SkillRegistryOptions) {
		this.#options = options;
		for (const skill of options.packageSkills ?? []) {
			const stored = options.store.skill(skill.name);
			if (stored)
				throw new PluginError(
					`The skill "${skill.name}" of the package "${skill.package}" clashes with a ${stored.kind} skill of the same name. Drop the package from skills.packages and start, remove the ${stored.kind} skill (${stored.kind === "linked" ? "skill_unlink" : "skill_delete"}), then list the package again.`,
				);
			this.#packageSkills.set(skill.name, skill);
		}
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
		return skillCatalog(
			this.#options.store,
			[...this.#packageSkills.values()],
			(name) => this.#resolveOne(name),
		);
	}

	/** Every skill, or those of a group or matching a query (behavior 14). */
	list(filter: { group?: string; query?: string } = {}): string {
		return skillListText(
			this.#options.store,
			[...this.#packageSkills.values()],
			(name) => this.#resolveOne(name),
			filter,
		);
	}

	/** Throws when a name is not registered; built-in names are carried already. */
	checkRegistered(names: readonly string[]): void {
		const unknown = names.filter((name) => !this.#registered(name));
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
		this.#refusePackage(name);
		const entry = this.#entry(name);
		if (entry.kind !== "linked")
			throw new AgentError(
				`${name} is written by an agent; remove it with skill_delete.`,
			);
		return this.#removed(name, await this.#options.store.remove(name));
	}

	async create(
		skill: {
			name: string;
			description: string;
			body: string;
		},
		by = "agent",
	): Promise<string> {
		checkSkillName(skill.name);
		this.#checkFreeName(skill.name);
		checkDescription(skill.description);
		checkBody(skill.body);
		const entry = {
			name: skill.name,
			description: skill.description.trim(),
			body: skill.body.trim(),
		};
		await this.#options.store.addWritten(entry, by);
		this.#write(entry);
		return `Created skill ${skill.name}. Attach it with agent_skills; it loads from each carrier's next turn.`;
	}

	async update(
		name: string,
		change: { description?: string; body?: string },
		by = "agent",
	): Promise<string> {
		const entry = this.#writable(name);
		if (change.description !== undefined) checkDescription(change.description);
		if (change.body !== undefined) checkBody(change.body);
		const next = {
			name,
			description: change.description?.trim() ?? entry.description,
			body: change.body?.trim() ?? entry.body,
		};
		await this.#options.store.updateWritten(next, by);
		this.#write(next);
		return `Updated skill ${name}; its carriers read the new version from their next turn.`;
	}

	// ── Documents: a SKILL.md as the owner edits it in the web app ─────────

	/** A skill's SKILL.md; throws AgentError for an unknown skill or one whose file cannot be read. */
	async document(name: string): Promise<SkillDocument> {
		const source = this.#sourceOf(name);
		const entry = this.#options.store.skill(name);
		if (entry?.kind === "written") return this.#documentOf(entry);
		const file = this.#fileOf(name);
		if (!source || !file) throw new AgentError(`There is no skill "${name}".`);
		return this.#readDocument(name, source, file);
	}

	/**
	 * Saves an agent-written skill's whole SKILL.md as edited from the one with hash `baseHash`.
	 * The name cannot change; the description and body are checked as the skill tools check them.
	 * Throws SkillConflictError, carrying the current document, when the skill is no longer the
	 * one that was edited, and AgentError for a read-only skill or a refused text.
	 */
	saveDocument(
		name: string,
		text: string,
		baseHash: string,
		by: string,
	): Promise<SkillDocument> {
		return this.#inDocuments(async () => {
			const entry = this.#writable(name);
			const current = this.#documentOf(entry);
			if (current.hash !== baseHash) throw new SkillConflictError(current);
			const next = parseSkillDocument(text);
			if (next.name !== name)
				throw new AgentError(
					`The name of a skill cannot change (it is "${name}"). To use another name, create a new skill.`,
				);
			if (next.description === entry.description && next.body === entry.body)
				return current;
			await this.update(
				name,
				{ description: next.description, body: next.body },
				by,
			);
			return this.document(name);
		});
	}

	/** Makes a skill from a whole SKILL.md; it is attached to no one. Throws AgentError for a taken or refused name or text. */
	createDocument(text: string, by: string): Promise<SkillDocument> {
		return this.#inDocuments(async () => {
			const made = parseSkillDocument(text);
			await this.create(made, by);
			return this.document(made.name);
		});
	}

	/** The saved versions of an agent-written skill, newest first; none for any other skill. */
	async documentHistory(name: string): Promise<SkillVersion[]> {
		const entry = this.#options.store.skill(name);
		if (entry?.kind !== "written") {
			this.#sourceOf(name);
			return [];
		}
		return (await this.#options.store.versions(name)).map((version) => {
			const text = skillFileContent({
				name,
				description: version.description,
				body: version.body,
			});
			return {
				id: version.id,
				text,
				hash: hashOf(text),
				by: version.by,
				at: version.at,
			};
		});
	}

	#inDocuments<T>(write: () => Promise<T>): Promise<T> {
		const run = this.#documents.then(write);
		this.#documents = run.catch(() => undefined);
		return run;
	}

	#documentOf(entry: Extract<SkillEntry, { kind: "written" }>): SkillDocument {
		const text = skillFileContent(entry);
		return {
			name: entry.name,
			source: { kind: "written" },
			text,
			hash: hashOf(text),
			writable: true,
		};
	}

	#readDocument(
		name: string,
		source: SkillSource,
		file: string,
	): SkillDocument {
		let size: number;
		try {
			size = statSync(file).size;
		} catch {
			throw new AgentError(`The file of the skill "${name}" cannot be read.`);
		}
		if (size > MAX_DOCUMENT_BYTES)
			throw new AgentError(
				`The file of the skill "${name}" is too large to show.`,
			);
		const text = readFileSync(file, "utf8");
		return { name, source, text, hash: hashOf(text), writable: false };
	}

	/** Where a skill comes from; throws AgentError for a name nobody registered. */
	#sourceOf(name: string): SkillSource {
		if ((BUILTIN_SKILLS as readonly string[]).includes(name))
			return { kind: "builtin" };
		const fromPackage = this.#packageSkills.get(name);
		if (fromPackage) return { kind: "package", package: fromPackage.package };
		const entry = this.#options.store.skill(name);
		if (!entry) throw new AgentError(`There is no skill "${name}".`);
		return entry.kind === "linked"
			? { kind: "linked", repo: entry.repo, path: entry.path }
			: { kind: "written" };
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
				!this.#registered(skill) &&
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
		const fromPackage = this.#packageSkills.get(name);
		if (fromPackage) return fromPackage.file;
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

	#registered(name: string): boolean {
		return (
			this.#packageSkills.has(name) ||
			this.#options.store.skill(name) !== undefined
		);
	}

	/** Package skills change with their package, never here. */
	#refusePackage(name: string): void {
		const fromPackage = this.#packageSkills.get(name);
		if (fromPackage)
			throw new AgentError(
				`${name} comes from the package ${fromPackage.package} and is read-only here. It changes when the package is upgraded.`,
			);
	}

	#writable(name: string): Extract<SkillEntry, { kind: "written" }> {
		this.#refusePackage(name);
		const entry = this.#entry(name);
		if (entry.kind !== "written")
			throw new AgentError(
				`${name} is linked from ${entry.repo}:${entry.path} and is read-only here. Change it in the repository with repo_task, then ship it with repo_change_report and repo_push.`,
			);
		return entry;
	}

	#checkFreeName(name: string): void {
		const fromPackage = this.#packageSkills.get(name);
		if (fromPackage)
			throw new AgentError(
				`A skill named "${name}" already exists: it comes from the package ${fromPackage.package}.`,
			);
		if (
			(BUILTIN_SKILLS as readonly string[]).includes(name) ||
			this.#packageSkills.has(name) ||
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
