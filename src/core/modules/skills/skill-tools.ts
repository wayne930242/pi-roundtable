import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AgentError } from "../../domain/errors.ts";
import {
	optionalString,
	requiredString,
	stringList,
	textToolsExtension,
} from "../../runtime/text-tools.ts";
import type { SkillRegistry } from "../../services.ts";
import {
	MAX_SKILL_BODY_CHARS,
	type StoredSkillRegistry,
} from "./skill-registry.ts";

export const SKILL_LIST_TOOL = "skill_list";

/** The skill tools only agents have; the DM reads the registry with skill_list alone. */
export const SKILL_TOOLS = [
	"skill_link",
	"skill_unlink",
	"skill_create",
	"skill_update",
	"skill_delete",
	"skill_group_set",
	"skill_group_delete",
	"agent_skills",
] as const;

const SKILL_NAME = Type.String({
	description: "A skill's name, from skill_list.",
});
const SKILL_NAMES = Type.Array(Type.String(), {
	description: "Skill names, from skill_list.",
});
const DESCRIPTION = Type.String({
	minLength: 1,
	maxLength: 1024,
	description:
		'When to use the skill and nothing else, starting with "Use when": one trigger per distinct way it is used, no summary of its steps.',
});
const BODY = Type.String({
	minLength: 1,
	maxLength: MAX_SKILL_BODY_CHARS,
	description:
		"The Markdown body after the frontmatter, which the tool writes. Follow the writing-skills skill: short, stated positively, steps ending on a checkable completion criterion.",
});

/** skill_list, for the DM and for agents. */
export function skillListExtension(
	registry: Pick<SkillRegistry, "list">,
): ExtensionFactory {
	return textToolsExtension(
		[
			{
				name: SKILL_LIST_TOOL,
				label: "List skills",
				description:
					"List the skill registry: each skill's kind (built in, linked from a repository and read-only, or written by an agent), description, groups, and the agents carrying it, then the skill groups. Filter by a group or a word.",
				parameters: Type.Object({
					group: Type.Optional(
						Type.String({ description: "A skill group's name." }),
					),
					query: Type.Optional(
						Type.String({
							description: "A word to find in names and descriptions.",
						}),
					),
				}),
				run: (i) => {
					const group = optionalString(i, "group");
					const query = optionalString(i, "query");
					return registry.list({
						...(group ? { group } : {}),
						...(query ? { query } : {}),
					});
				},
			},
		],
		AgentError,
	);
}

/** The skill tools of an agent session. */
export function skillToolsExtension(
	registry: StoredSkillRegistry,
	/** Throws AgentError unless the name is an active agent. */
	checkAgent: (name: string) => void,
): ExtensionFactory {
	return textToolsExtension(
		[
			{
				name: "skill_link",
				label: "Link skills",
				description:
					"Register a skill that lives in a managed repository: the path of a folder with SKILL.md, or of a folder whose child folders hold skills, all of which are linked. Name and description come from each file. Linked skills are read-only here; they change in their repository.",
				parameters: Type.Object({
					repo: Type.String({ description: "<owner>/<repo>, from repo_list." }),
					path: Type.String({
						description:
							"A folder inside the repository, such as skills/plan-work or skills.",
					}),
				}),
				run: (i) =>
					registry.link(requiredString(i, "repo"), requiredString(i, "path")),
			},
			{
				name: "skill_unlink",
				label: "Unlink skill",
				description:
					"Remove a linked skill from the registry; it is detached from every agent and group. The repository is untouched.",
				parameters: Type.Object({ name: SKILL_NAME }),
				run: (i) => registry.unlink(requiredString(i, "name")),
			},
			{
				name: "skill_create",
				label: "Create skill",
				description:
					"Write a new skill into the registry. Read the writing-skills skill first. It does not attach the skill to anyone; use agent_skills.",
				parameters: Type.Object({
					name: Type.String({
						pattern: "^[a-z0-9-]{1,64}$",
						description:
							"Permanent: lowercase letters, digits, and single hyphens.",
					}),
					description: DESCRIPTION,
					body: BODY,
				}),
				run: (i) =>
					registry.create({
						name: requiredString(i, "name"),
						description: requiredString(i, "description"),
						body: requiredString(i, "body"),
					}),
			},
			{
				name: "skill_update",
				label: "Update skill",
				description:
					"Replace a agent-written skill's description or body whole; read its SKILL.md (path in skill_list) first. Its carriers read the new version from their next turn.",
				parameters: Type.Object({
					name: SKILL_NAME,
					description: Type.Optional(DESCRIPTION),
					body: Type.Optional(BODY),
				}),
				run: (i) => {
					const description = optionalString(i, "description");
					const body = optionalString(i, "body");
					return registry.update(requiredString(i, "name"), {
						...(description !== undefined ? { description } : {}),
						...(body !== undefined ? { body } : {}),
					});
				},
			},
			{
				name: "skill_delete",
				label: "Delete skill",
				description:
					"Delete a agent-written skill; it is detached from every agent and group.",
				parameters: Type.Object({ name: SKILL_NAME }),
				run: (i) => registry.delete(requiredString(i, "name")),
			},
			{
				name: "skill_group_set",
				label: "Set skill group",
				description:
					"Create or replace a skill group, a named list that only filters skill_list. Agents carry skills, not groups.",
				parameters: Type.Object({
					name: Type.String({ pattern: "^[a-z0-9-]{1,64}$" }),
					description: Type.String({ minLength: 1, maxLength: 200 }),
					skills: SKILL_NAMES,
				}),
				run: (i) =>
					registry.setGroup(
						requiredString(i, "name"),
						requiredString(i, "description"),
						stringList(i, "skills") ?? [],
					),
			},
			{
				name: "skill_group_delete",
				label: "Delete skill group",
				description: "Delete a skill group; its skills are untouched.",
				parameters: Type.Object({ name: Type.String() }),
				run: (i) => registry.deleteGroup(requiredString(i, "name")),
			},
			{
				name: "agent_skills",
				label: "Change agent skills",
				description:
					"Add and remove skills an agent carries, yours included; it applies from that agent's next turn. Built-in skills stay. An unknown name refuses the whole call.",
				parameters: Type.Object({
					agent: Type.String({
						description: "An agent's name, from agent_list.",
					}),
					add: Type.Optional(SKILL_NAMES),
					remove: Type.Optional(SKILL_NAMES),
				}),
				run: async (i) => {
					const agent = requiredString(i, "agent");
					checkAgent(agent);
					const carried = await registry.attach(
						agent,
						stringList(i, "add") ?? [],
						stringList(i, "remove") ?? [],
					);
					return `${agent} now carries: ${carried.join(", ") || "only the built-in skills"}.`;
				},
			},
		],
		AgentError,
	);
}
