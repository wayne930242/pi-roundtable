import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { toolText } from "pi-roundtable/kit";
import { Type } from "typebox";

export interface SkillEntry {
	name: string;
	description: string;
	/** Tools that run only after this skill is read in the session, from frontmatter `tools`. */
	tools: string[];
}

const MAX_READ_CHARS = 40_000;

function frontmatter(text: string): Record<string, unknown> {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!match?.[1]) return {};
	const parsed = Bun.YAML.parse(match[1]);
	return parsed && typeof parsed === "object"
		? (parsed as Record<string, unknown>)
		: {};
}

/** Each `<dir>/<skill>/SKILL.md` with a name and description; a skill without them fails startup. */
export function loadSkillIndex(dir: string): SkillEntry[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() && existsSync(join(dir, entry.name, "SKILL.md")),
		)
		.map((entry) => {
			const meta = frontmatter(
				readFileSync(join(dir, entry.name, "SKILL.md"), "utf8"),
			);
			if (
				meta.name !== entry.name ||
				typeof meta.description !== "string" ||
				!meta.description
			) {
				throw new Error(
					`skill ${entry.name} needs a matching name and a description`,
				);
			}
			const tools = Array.isArray(meta.tools)
				? meta.tools.filter((tool): tool is string => typeof tool === "string")
				: [];
			return { name: entry.name, description: meta.description, tools };
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** The skills list for the system prompt, in the shape Pi uses for its own skills. */
export function skillsPromptBlock(skills: readonly SkillEntry[]): string {
	if (skills.length === 0) return "";
	const entries = skills.map(
		(skill) =>
			`  <skill>\n    <name>${skill.name}</name>\n    <description>${skill.description}</description>\n  </skill>`,
	);
	return [
		"These skills hold this channel's own procedures, which differ from general knowledge: which tools to call, what to record, what to ask first. When a request matches a skill's description, read it with read_skill before you answer or call any other tool, even on a subject you know well, unless you already read it in this conversation; load the files it points to the same way.",
		"<available_skills>",
		...entries,
		"</available_skills>",
	].join("\n");
}

/**
 * `read_skill` reads only files inside the skills directory. A tool a skill claims is blocked
 * until that skill's SKILL.md is read in the session, because the model skips skills whose
 * subject it thinks it knows, and the skill holds this channel's own procedure.
 * The built-in read tool stays off,
 * because it could also read the channel's memory and session files.
 */
export function skillsExtension(
	dir: string,
	skills: readonly SkillEntry[],
): ExtensionFactory {
	const known = new Set(skills.map((skill) => skill.name));
	const owners = new Map(
		skills.flatMap((skill) => skill.tools.map((tool) => [tool, skill.name])),
	);
	const read = new Set<string>();
	return (pi) => {
		pi.on("tool_call", (event) => {
			const owner = owners.get(event.toolName);
			return owner && !read.has(owner)
				? {
						block: true,
						reason: `Read the ${owner} skill with read_skill first; it sets how ${event.toolName} is used here.`,
					}
				: undefined;
		});

		pi.registerTool({
			name: "read_skill",
			label: "Read skill",
			description:
				"Load a skill's instructions (SKILL.md) or a file it references, such as ref/major-symbols.md.",
			parameters: Type.Object({
				skill: Type.String({
					description: "Skill name from the available skills.",
				}),
				path: Type.Optional(
					Type.String({
						description: "File inside the skill; default SKILL.md.",
					}),
				),
			}),
			execute: async (_toolCallId, params) => {
				if (!known.has(params.skill))
					throw new Error(`there is no skill named ${params.skill}`);
				const base = realpathSync(dir);
				const root = realpathSync(resolve(base, params.skill));
				if (!root.startsWith(`${base}${sep}`))
					throw new Error("Skill directory escapes the content tree");
				const file = realpathSync(resolve(root, params.path ?? "SKILL.md"));
				if (!file.startsWith(`${root}${sep}`) || !existsSync(file)) {
					throw new Error(`${params.path} is not a file of ${params.skill}`);
				}
				if (statSync(file).size > 256 * 1024)
					throw new Error("Skill file too large");
				const text = readFileSync(file, "utf8");
				if (file === join(root, "SKILL.md")) read.add(params.skill);
				return toolText(
					text.length > MAX_READ_CHARS
						? `${text.slice(0, MAX_READ_CHARS)}\n\n[truncated at ${MAX_READ_CHARS} characters]`
						: text,
				);
			},
		});
	};
}
