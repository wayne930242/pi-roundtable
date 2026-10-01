import { AgentError } from "../../domain/errors.ts";
import {
	BUILTIN_SKILLS,
	cut,
	MAX_LIST_DESCRIPTION_CHARS,
	type ResolvedSkill,
	type SkillCatalogEntry,
	type SkillSource,
} from "./skill-rules.ts";
import type { SkillStore } from "./skill-store.ts";

/** Resolves a skill by name to its file, or says why it cannot. */
export type SkillResolver = (
	name: string,
) => ResolvedSkill | { name: string; reason: string };

/** Every skill, built-in ones first, with what `list` shows as text (web app spec behavior 15). */
export function skillCatalog(
	store: SkillStore,
	resolveOne: SkillResolver,
): SkillCatalogEntry[] {
	const sources: { name: string; source: SkillSource }[] = [
		...BUILTIN_SKILLS.map((name) => ({
			name,
			source: { kind: "builtin" } as const,
		})),
		...store.skills().map((entry) => ({
			name: entry.name,
			source:
				entry.kind === "linked"
					? ({ kind: "linked", repo: entry.repo, path: entry.path } as const)
					: ({ kind: "written" } as const),
		})),
	];
	return sources.map(({ name, source }) => {
		const one = resolveOne(name);
		return {
			name,
			source,
			...("reason" in one
				? { missing: one.reason }
				: { description: one.description, file: one.file }),
			groups: store
				.groups()
				.flatMap((g) => (g.skills.includes(name) ? [g.name] : [])),
			carriers: store.carriers(name),
		};
	});
}

/** Every skill, or those of a group or matching a query (behavior 14). */
export function skillListText(
	store: SkillStore,
	resolveOne: SkillResolver,
	filter: { group?: string; query?: string } = {},
): string {
	const group = filter.group ? store.group(filter.group) : undefined;
	if (filter.group && !group)
		throw new AgentError(
			`There is no skill group "${filter.group}". Groups: ${
				store
					.groups()
					.map((g) => g.name)
					.join(", ") || "none"
			}.`,
		);
	const query = filter.query?.toLowerCase();
	const rows: string[] = [];
	const builtins = BUILTIN_SKILLS.map((name) => ({
		name,
		source: "built in, carried by every agent and worker",
	}));
	const entries = [
		...builtins,
		...store.skills().map((entry) => ({
			name: entry.name,
			source:
				entry.kind === "linked"
					? `linked from ${entry.repo}:${entry.path}`
					: "written by an agent",
		})),
	];
	for (const { name, source } of entries) {
		if (group && !group.skills.includes(name)) continue;
		const one = resolveOne(name);
		const description = "reason" in one ? "" : one.description;
		if (
			query &&
			!name.includes(query) &&
			!description.toLowerCase().includes(query)
		)
			continue;
		const groups = store
			.groups()
			.flatMap((g) => (g.skills.includes(name) ? [g.name] : []));
		const carriers = store.carriers(name);
		const missing = "reason" in one ? ` — missing: ${one.reason}` : "";
		rows.push(
			[
				`- ${name} [${source}]${missing}`,
				description
					? `  ${cut(description, MAX_LIST_DESCRIPTION_CHARS)}`
					: undefined,
				groups.length > 0 ? `  groups: ${groups.join(", ")}` : undefined,
				carriers.length > 0
					? `  carried by: ${carriers.join(", ")}`
					: undefined,
			]
				.filter(Boolean)
				.join("\n"),
		);
	}
	const groupLines = store
		.groups()
		.map(
			(g) =>
				`- ${g.name}: ${g.description} (${g.skills.join(", ") || "empty"})`,
		);
	return [
		`Skills${group ? ` in group ${group.name}` : ""}${query ? ` matching "${filter.query}"` : ""} (${rows.length}):`,
		rows.join("\n") || "none",
		"",
		"Skill groups:",
		groupLines.join("\n") || "none",
	].join("\n");
}
