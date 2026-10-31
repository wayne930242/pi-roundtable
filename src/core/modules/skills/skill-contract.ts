import type {
	SkillCatalogEntry,
	SkillDocument,
	SkillSet,
	SkillVersion,
} from "./skill-rules.ts";
import type { SkillGroup } from "./skill-store.ts";

/** The skills agents carry: built in, linked from repositories, or written by an agent. */
export interface SkillRegistry {
	/** The built-in skills plus the named registered ones, resolved to their files. */
	resolve(names: readonly string[]): SkillSet;
	/** What an agent carries, built-in skills included. */
	carried(agent: string): SkillSet;
	/** The registered skills an agent carries, as the dashboard lists them. */
	carriedNames(agent: string): string[];
	/** An agent's skills as `agent_get` shows them. */
	describeCarried(agent: string): string;
	/** Every skill, built-in ones first. */
	catalog(): SkillCatalogEntry[];
	/** Every skill, or those of a group or matching a query, as the `skill_list` tool shows them. */
	list(filter?: { group?: string; query?: string }): string;
	/** The skills linked from a managed repository. */
	linkedFrom(repo: string): string[];
	/** Throws AgentError when a name is not registered; built-in names are carried already. */
	checkRegistered(names: readonly string[]): void;
	/** Links the skill at a repository path, or every child folder with a SKILL.md. */
	link(repo: string, path: string): Promise<string>;
	/** A skill's SKILL.md, whole, with its hash and whether it is editable (only an agent-written skill is). Throws AgentError for an unknown skill or one whose file cannot be read. */
	document(name: string): Promise<SkillDocument>;
	/**
	 * Saves an agent-written skill's whole SKILL.md, edited from the one with hash `baseHash`; `by`
	 * is kept with the version. The name cannot change, and the description and body are checked as
	 * `skill_update` checks them. Throws `SkillConflictError` (with the current document) when the
	 * skill changed meanwhile and AgentError for a read-only skill or a refused text.
	 */
	saveDocument(
		name: string,
		text: string,
		baseHash: string,
		by: string,
	): Promise<SkillDocument>;
	/** Makes a skill from a whole SKILL.md, as `skill_create` does; it is attached to no one. Throws AgentError for a taken or refused name or text. */
	createDocument(text: string, by: string): Promise<SkillDocument>;
	/** Deletes an agent-written skill and detaches it from every agent and group, as `skill_delete` does; returns what it was detached from. Throws AgentError for any other skill. */
	delete(name: string): Promise<string>;
	/** The saved versions of an agent-written skill, newest first; none for any other skill. */
	documentHistory(name: string): Promise<SkillVersion[]>;
	/** Every skill group, by name: a named list of skills to filter by or apply to an agent once; an agent carries skills, not groups. */
	groups(): SkillGroup[];
	/** Creates or replaces a group; returns what it did. Throws AgentError for a refused name, an empty description or an unknown skill. */
	setGroup(
		name: string,
		description: string,
		skills: readonly string[],
	): Promise<string>;
	/** Deletes a group and leaves its skills and their carriers as they are; returns what it did. Throws AgentError for an unknown group. */
	deleteGroup(name: string): Promise<string>;
	/** Adds and removes an agent's registered skills together, or changes nothing; returns what it carries after. */
	attach(
		agent: string,
		add: readonly string[],
		remove: readonly string[],
	): Promise<string[]>;
}
