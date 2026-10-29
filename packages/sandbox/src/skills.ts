import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import type { HostTool } from "./broker.ts";
import { pageText } from "./paging.ts";
import { isRecord, toolResultTextBytes } from "./protocol.ts";

/** The name the model reaches the skill reader by is `host_read_skill`. */
export const READ_SKILL_TOOL = "read_skill";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SEGMENTS = 16;

export interface SealedSkill {
	name: string;
	description: string;
	/** The skill's folder, as configured. */
	path: string;
}
export interface SealedSkills {
	skills: SealedSkill[];
	/** The sentence and list appended to the system prompt. */
	index: string;
	/** The host tool that reads a skill's files; skill files are never mounted into a container. */
	tool: HostTool;
}

/** The YAML between the `---` lines that open the file; undefined when it has none or never closes. */
function frontmatter(text: string): Record<string, unknown> | undefined {
	const lines = text.split(/\r?\n/);
	if (lines[0] !== "---") return undefined;
	const end = lines.indexOf("---", 1);
	if (end < 0) return undefined;
	const parsed: unknown = Bun.YAML.parse(lines.slice(1, end).join("\n"));
	return isRecord(parsed) ? parsed : undefined;
}

function describe(folder: string, name: string): SealedSkill {
	const file = join(folder, "SKILL.md");
	if (!existsSync(file))
		throw new Error(`skill folder ${folder} has no SKILL.md`);
	let data: Record<string, unknown> | undefined;
	try {
		data = frontmatter(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(
			`skill ${file} has unreadable frontmatter: ${(error as Error).message}`,
		);
	}
	if (!data) throw new Error(`skill ${file} has no valid frontmatter`);
	if (data.name !== name)
		throw new Error(
			`skill ${file}: frontmatter name ${JSON.stringify(data.name)} must equal the folder name ${JSON.stringify(name)}`,
		);
	if (typeof data.description !== "string" || !data.description.trim())
		throw new Error(
			`skill ${file} needs a non-empty description in its frontmatter`,
		);
	return {
		name,
		description: data.description.replace(/\s+/g, " ").trim(),
		path: folder,
	};
}

/**
 * Loads the skill folders of `directories` once, at startup, and fails fast on a missing
 * directory, a folder without valid frontmatter, a name that differs from its folder, or two
 * skills of one name.
 */
export function loadSealedSkills(directories: readonly string[]): SealedSkills {
	const found = new Map<string, SealedSkill>();
	for (const directory of directories) {
		if (!isAbsolute(directory))
			throw new Error(`skills directory ${directory} must be an absolute path`);
		let entries: string[];
		try {
			if (!statSync(directory).isDirectory())
				throw new Error("not a directory");
			entries = readdirSync(directory).filter(
				(entry) => !entry.startsWith("."),
			);
		} catch {
			throw new Error(
				`skills directory ${directory} does not exist or is not a directory`,
			);
		}
		for (const entry of entries.sort()) {
			const folder = join(directory, entry);
			if (!statSync(folder).isDirectory()) continue;
			if (!NAME.test(entry))
				throw new Error(
					`skill folder ${folder} has a name outside letters, digits, dot, dash and underscore`,
				);
			const skill = describe(folder, entry);
			const earlier = found.get(skill.name);
			if (earlier)
				throw new Error(
					`two skills are named ${skill.name}: ${earlier.path} and ${skill.path}`,
				);
			found.set(skill.name, skill);
		}
	}
	const skills = [...found.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
	const index = [
		`Before answering, if a skill below matches the request, read it first with host_${READ_SKILL_TOOL} (pass its name), then answer by it. Skills:`,
		...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
	].join("\n");
	return { skills, index, tool: readSkillTool(found) };
}

function refusal(message: string): string {
	return `Error: ${message}`;
}

function readSkillTool(skills: ReadonlyMap<string, SealedSkill>): HostTool {
	return {
		name: READ_SKILL_TOOL,
		description:
			"Read a skill's SKILL.md, or another file inside that skill's folder by path. A long file is paged: when more follows, the first line names the next offset.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "The skill's name." },
				path: {
					type: "string",
					description: "A file inside the skill's folder; omit for SKILL.md.",
				},
				offset: { type: "integer", minimum: 0 },
			},
			required: ["name"],
			additionalProperties: false,
		},
		run: (input, context) => {
			const skill =
				typeof input.name === "string" ? skills.get(input.name) : undefined;
			if (!skill) return refusal("no skill has that name");
			const path = input.path === undefined ? "SKILL.md" : input.path;
			if (
				typeof path !== "string" ||
				!path ||
				path.length > 512 ||
				path.includes("\0") ||
				path.startsWith("/")
			)
				return refusal(
					"path must be a relative path inside the skill's folder",
				);
			const segments = path.split("/");
			if (
				segments.length > MAX_SEGMENTS ||
				segments.some(
					(segment) => !segment || segment === "." || segment === "..",
				)
			)
				return refusal("path has an empty, dot or parent segment");
			const offset = input.offset === undefined ? 0 : input.offset;
			if (typeof offset !== "number")
				return refusal("offset must be a whole number");
			let text: string;
			try {
				const base = realpathSync(skill.path);
				const target = realpathSync(join(base, ...segments));
				if (!target.startsWith(base + sep))
					return refusal("path leaves the skill's folder");
				const info = statSync(target);
				if (!info.isFile() || info.size > MAX_FILE_BYTES)
					return refusal("not a readable file");
				text = readFileSync(target, "utf8");
			} catch {
				return refusal("no such file in that skill");
			}
			try {
				return pageText(text, offset, context.resultBytes, toolResultTextBytes);
			} catch (error) {
				return refusal((error as Error).message);
			}
		},
	};
}
