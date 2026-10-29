import { createHash } from "node:crypto";
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
	| { kind: "written" }
	| { kind: "package"; package: string };

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

/** A skill an installed npm package offers through its `pi.skills` folders. */
export interface PackageSkill {
	name: string;
	/** The npm package that holds it. */
	package: string;
	/** Its SKILL.md in the installed package. */
	file: string;
}

export interface SkillRegistryOptions {
	store: SkillStore;
	/** Managed repositories, as `<dir>/<owner>/<repo>`. */
	reposDir: string;
	/** Where agent-written skills are written for Pi to read. */
	writtenDir: string;
	/** The release's built-in skills, as `<dir>/<name>/SKILL.md`. */
	builtinDir: string;
	/** Skills of installed packages, as `discoverPackageSkills` found them at startup. */
	packageSkills?: readonly PackageSkill[];
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

/** The most bytes of a SKILL.md the registry reads for the web app. */
export const MAX_DOCUMENT_BYTES = 64 * 1024;

/** A skill's SKILL.md as the owner reads and edits it. */
export interface SkillDocument {
	name: string;
	source: SkillSource;
	/** The whole file: frontmatter and body. */
	text: string;
	/** SHA-256 of `text`; a save names the hash it was edited from. */
	hash: string;
	/** An agent-written skill; the others are read-only here. */
	writable: boolean;
}

/** One saved version of an agent-written skill's SKILL.md. */
export interface SkillVersion {
	id: number;
	text: string;
	hash: string;
	/** Who saved it: the owner's name, or `agent` for a skill tool. */
	by: string;
	at: Date;
}

/** A save made from a SKILL.md that is no longer the current one; `current` is what is there now. */
export class SkillConflictError extends Error {
	override name = "SkillConflictError";
	constructor(readonly current: SkillDocument) {
		super(`The skill "${current.name}" changed while it was being edited.`);
	}
}

export const hashOf = (text: string): string =>
	createHash("sha256").update(text).digest("hex");

/** The fields a SKILL.md holds when the registry writes it; any other frontmatter key is refused. */
const FRONTMATTER_KEYS = ["name", "description"] as const;

/**
 * Reads a SKILL.md the owner wrote: frontmatter with a `name` and a `description`, then the body.
 * The description and body are checked as the skill tools check them (`checkDescription`,
 * `checkBody`), and a key besides the two is refused rather than dropped when the file is written
 * again. Throws AgentError with the reason.
 */
export function parseSkillDocument(text: string): {
	name: string;
	description: string;
	body: string;
} {
	const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	if (!normalized.startsWith("---\n") || !normalized.includes("\n---", 3))
		throw new AgentError(
			"A SKILL.md starts with frontmatter between two --- lines, holding name and description.",
		);
	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter<Record<string, unknown>>(normalized);
	} catch (error) {
		throw new AgentError(
			`The frontmatter is not valid YAML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
		);
	}
	const { frontmatter, body } = parsed;
	if (
		typeof frontmatter !== "object" ||
		frontmatter === null ||
		Array.isArray(frontmatter)
	)
		throw new AgentError(
			"The frontmatter must be keys and values: name and description.",
		);
	const extra = Object.keys(frontmatter).filter(
		(key) => !(FRONTMATTER_KEYS as readonly string[]).includes(key),
	);
	if (extra.length > 0)
		throw new AgentError(
			`The frontmatter has ${extra.map((key) => `"${key}"`).join(", ")}; only name and description are kept.`,
		);
	const { name, description } = frontmatter;
	if (typeof name !== "string" || !name.trim())
		throw new AgentError("The frontmatter needs a name.");
	if (typeof description !== "string" || !description.trim())
		throw new AgentError("The frontmatter needs a description.");
	checkDescription(description);
	checkBody(body);
	return {
		name: name.trim(),
		description: description.trim(),
		body: body.trim(),
	};
}
