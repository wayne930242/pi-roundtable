import type { ApiError } from "./api-common-types.ts";
import type { SkillView } from "./console-types.ts";

/** A skill's SKILL.md as `GET api/skill-docs/<name>` answers: the whole file, with the hash a save names. */
export interface SkillDocView {
	name: string;
	source: SkillView["source"];
	text: string;
	hash: string;
	/** An agent-written skill; the others are read-only here, for the reason their source gives. */
	writable: boolean;
}

/** The body of `PUT api/skill-docs/<name>`: the whole file, and the hash it was edited from. */
export interface SkillDocSave {
	text: string;
	baseHash: string;
}

/** The body of `POST api/skill-docs`, which makes a skill from a whole SKILL.md. */
export interface SkillDocCreate {
	text: string;
}

/** The answer of `DELETE api/skill-docs/<name>`: the registry's words, naming the agents it was detached from. */
export interface SkillDeleted {
	message: string;
}

/** A skill group: a named list of skills to filter by and to apply to a knight once. A knight carries skills, not groups. */
export interface SkillGroupView {
	name: string;
	description: string;
	skills: string[];
}

/** The answer of `GET api/skill-groups`, by name. */
export interface SkillGroupsView {
	groups: SkillGroupView[];
}

/** The body of `PUT api/skill-groups/<name>`, which creates or replaces a group; `from` renames the group it names. */
export interface SkillGroupSave {
	description: string;
	skills: string[];
	from?: string;
}

/**
 * The body of `POST api/skill-groups/<name>/apply`. `on` (the default) switches on the group's skills
 * the knight lacks; `on: false` switches off the group's skills it carries, built-in ones excepted.
 */
export interface SkillGroupApply {
	agent: string;
	on?: boolean;
}

/** The answer of applying a group: the skills newly switched on and those switched off, in the group's order. */
export interface SkillGroupApplied {
	added: string[];
	removed: string[];
}

/** The answer of a group's save or delete: the registry's words. */
export interface SkillGroupChanged {
	message: string;
}

/** A 409: the skill is not as the writer saw it. */
export interface SkillConflict extends ApiError {
	conflict: "changed";
	current: SkillDocView;
}

export interface SkillVersionView {
	id: number;
	text: string;
	hash: string;
	by: string;
	/** ISO time. */
	at: string;
}

export interface SkillHistoryView {
	versions: SkillVersionView[];
}

/** A skill as the agent sheet offers it: the host's catalog, and whether this agent carries it. */
export interface SkillChoiceView {
	name: string;
	description?: string;
	source: "builtin" | "linked" | "written" | "package";
	/** Built-in skills are carried by every agent and cannot be taken off. */
	builtin: boolean;
	carried: boolean;
	/** Why its file cannot be read, for a skill that is listed but broken. */
	missing?: string;
}

/** `GET api/agents/<name>/skills` and the answer of `PUT`: every skill the host has. */
export interface AgentSkillsView {
	skills: SkillChoiceView[];
}

/** The body of `PUT api/agents/<name>/skills`: the same fields as the `agent_skills` tool. */
export interface AgentSkillsChange {
	add?: string[];
	remove?: string[];
}
