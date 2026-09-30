import { existsSync, readFileSync } from "node:fs";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { AgentError } from "../../domain/errors.ts";
import type { Logger } from "../../log.ts";
import type { SkillStore } from "./skill-store.ts";

/** Carried by every agent and worker, shipped in the release (behavior 20). */
export const BUILTIN_SKILLS = ["writing-skills"] as const;

export const MAX_SKILL_BODY_CHARS = 12_000;
const MAX_DESCRIPTION_CHARS = 1_024;
export const MAX_LIST_DESCRIPTION_CHARS = 200;

/** A skill as a session loads it. */
export interface ResolvedSkill {
	name: string;
	description: string;
	/** Its SKILL.md. */
	file: string;
}

export interface SkillSet {
	skills: ResolvedSkill[];
	/** Carried skills whose file is gone or unreadable, with the reason. */
	missing: { name: string; reason: string }[];
}

export type SkillSource =
	| { kind: "builtin" }
	| { kind: "linked"; repo: string; path: string }
	| { kind: "written" };

/** One skill as the web app lists it; a skill whose file cannot be read has `missing` instead. */
export interface SkillCatalogEntry {
	name: string;
	source: SkillSource;
	description?: string;
	/** Its SKILL.md. */
	file?: string;
	missing?: string;
	groups: string[];
	/** Agents carrying it; built-in skills are carried by every agent without being listed. */
	carriers: string[];
}

export interface SkillRegistryOptions {
	store: SkillStore;
	/** Managed repositories, as `<dir>/<owner>/<repo>`. */
	reposDir: string;
	/** Where agent-written skills are written for Pi to read. */
	writtenDir: string;
	/** The release's built-in skills, as `<dir>/<name>/SKILL.md`. */
	builtinDir: string;
	logger: Logger;
}

/** Pi's skill-name rule, so every registered name also loads. */
export function checkSkillName(name: string): void {
	if (
		!/^[a-z0-9-]{1,64}$/.test(name) ||
		name.startsWith("-") ||
		name.endsWith("-") ||
		name.includes("--")
	)
		throw new AgentError(
			`"${name}" is not a usable skill name: 1 to 64 lowercase letters, digits, and single hyphens, not at either end.`,
		);
}

export function checkDescription(description: string): void {
	if (!description.trim().startsWith("Use when"))
		throw new AgentError(
			'A description states only when to use the skill and starts with "Use when".',
		);
	if (description.length > MAX_DESCRIPTION_CHARS)
		throw new AgentError(
			`A description has at most ${MAX_DESCRIPTION_CHARS} characters; this one has ${description.length}.`,
		);
}

export function checkBody(body: string): void {
	if (!body.trim() || body.length > MAX_SKILL_BODY_CHARS)
		throw new AgentError(
			`A skill body has 1 to ${MAX_SKILL_BODY_CHARS} characters; this one has ${body.length}.`,
		);
}

/** A skill file's name and description as Pi reads them: the folder name stands in for a missing name. */
export function readSkillFile(
	file: string,
): { name: string; description: string } | { error: string } {
	if (!existsSync(file)) return { error: "file not found" };
	try {
		const { frontmatter } = parseFrontmatter<Record<string, unknown>>(
			readFileSync(file, "utf8"),
		);
		const description =
			typeof frontmatter.description === "string"
				? frontmatter.description.trim()
				: "";
		if (!description) return { error: "no description in its frontmatter" };
		const name =
			typeof frontmatter.name === "string" && frontmatter.name
				? frontmatter.name
				: (file.split("/").at(-2) ?? "");
		return { name, description };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

export const skillFileContent = (entry: {
	name: string;
	description: string;
	body: string;
}) =>
	`---\nname: ${entry.name}\ndescription: ${JSON.stringify(entry.description.trim())}\n---\n\n${entry.body.trim()}\n`;

export const cut = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;
