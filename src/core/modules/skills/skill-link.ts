import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative as relativePath, resolve } from "node:path";
import { AgentError } from "../../domain/errors.ts";
import { checkRepoName } from "./repo-name.ts";
import { checkSkillName, readSkillFile } from "./skill-rules.ts";

/** The child folders of `dir` that hold a SKILL.md, as paths from the repository root. */
function skillFoldersUnder(dir: string, relative: string): string[] {
	const prefix = relative ? `${relative}/` : "";
	const folders = readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() && existsSync(join(dir, entry.name, "SKILL.md"))
			? [`${prefix}${entry.name}`]
			: [],
	);
	// pi-lens-ignore: no-sort-without-comparator — folder paths sort by code unit, the same order on every machine
	return folders.sort();
}

/**
 * The skills a link would register: the one at a repository path, or every child folder with a
 * SKILL.md (behavior 15). Throws one error listing every problem, so nothing is half linked.
 */
export function planLinkedSkills(
	reposDir: string,
	repo: string,
	path: string,
	checkFreeName: (name: string) => void,
): { name: string; repo: string; path: string }[] {
	checkRepoName(repo);
	const repoDir = join(reposDir, repo);
	if (!existsSync(join(repoDir, ".git")))
		throw new AgentError(
			`${repo} is not a managed repository; add it with repo_add first.`,
		);
	const relative = relativePath(repoDir, resolve(repoDir, path.trim()));
	if (relative.startsWith("..") || isAbsolute(relative))
		throw new AgentError(`The path must stay inside ${repo}.`);
	const dir = join(repoDir, relative);
	if (!existsSync(dir) || !statSync(dir).isDirectory())
		throw new AgentError(`${repo} has no folder ${relative || "."}.`);
	const folders = existsSync(join(dir, "SKILL.md"))
		? [relative]
		: skillFoldersUnder(dir, relative);
	if (folders.length === 0)
		throw new AgentError(
			`${repo}:${relative || "."} has no SKILL.md, nor any folder with one.`,
		);
	const entries: { name: string; repo: string; path: string }[] = [];
	const problems: string[] = [];
	for (const folder of folders) {
		const read = readSkillFile(join(repoDir, folder, "SKILL.md"));
		if ("error" in read) {
			problems.push(`${folder}: ${read.error}`);
			continue;
		}
		try {
			checkSkillName(read.name);
			checkFreeName(read.name);
		} catch (error) {
			problems.push(`${folder}: ${(error as Error).message}`);
			continue;
		}
		entries.push({ name: read.name, repo, path: folder });
	}
	const names = entries.map((e) => e.name);
	const twice = names.filter((name, i) => names.indexOf(name) !== i);
	if (twice.length > 0)
		problems.push(`names used twice: ${[...new Set(twice)].join(", ")}`);
	if (problems.length > 0)
		throw new AgentError(
			`Nothing was linked:\n${problems.map((p) => `- ${p}`).join("\n")}`,
		);
	return entries;
}
