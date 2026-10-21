import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative as relativePath, resolve } from "node:path";
import { PluginError } from "../../errors.ts";
import { packageDir } from "../../shared/package-dir.ts";
import {
	BUILTIN_SKILLS,
	checkSkillName,
	type PackageSkill,
	readSkillFile,
} from "./skill-rules.ts";

/** The SKILL.md files under `path`: the file itself, or each skill folder found below a directory. */
function skillFilesAt(path: string): string[] {
	if (statSync(path).isFile()) return [path];
	if (existsSync(join(path, "SKILL.md"))) return [join(path, "SKILL.md")];
	return readdirSync(path, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() &&
				!entry.name.startsWith(".") &&
				entry.name !== "node_modules",
		)
		.flatMap((entry) => skillFilesAt(join(path, entry.name)));
}

/** The `pi.skills` entries of a package manifest, or undefined when it declares none. */
function manifestSkills(manifest: unknown): string[] | undefined {
	const skills = (manifest as { pi?: { skills?: unknown } } | null)?.pi?.skills;
	return Array.isArray(skills) &&
		skills.length > 0 &&
		skills.every((entry) => typeof entry === "string")
		? skills
		: undefined;
}

function packageSkillsOf(
	name: string,
	resolveDir: (name: string) => string,
): PackageSkill[] {
	let dir: string;
	try {
		dir = resolveDir(name);
	} catch {
		throw new PluginError(
			`config skills.packages: the package "${name}" is not installed. Install it next to the host, or remove it from skills.packages.`,
		);
	}
	let manifest: unknown;
	try {
		manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	} catch (error) {
		throw new PluginError(
			`config skills.packages: the package "${name}" has no readable package.json (${(error as Error).message}). Reinstall it, or remove it from skills.packages.`,
		);
	}
	const entries = manifestSkills(manifest);
	if (!entries)
		throw new PluginError(
			`config skills.packages: the package "${name}" lists no skills in its package.json "pi.skills". Remove it from skills.packages, or use a package that ships skills.`,
		);
	const files = entries.flatMap((entry) => {
		const path = resolve(dir, entry);
		const relative = relativePath(dir, path);
		if (relative.startsWith("..") || isAbsolute(relative))
			throw new PluginError(
				`config skills.packages: "${name}" lists the skills path "${entry}" outside the package. Use a package whose pi.skills stay inside it.`,
			);
		if (!existsSync(path))
			throw new PluginError(
				`config skills.packages: "${name}" lists the skills path "${entry}", which is not in the installed package. Reinstall the package, or remove it from skills.packages.`,
			);
		return skillFilesAt(path);
	});
	if (files.length === 0)
		throw new PluginError(
			`config skills.packages: the package "${name}" has no SKILL.md under its pi.skills. Remove it from skills.packages, or use a package that ships skills.`,
		);
	return files.map((file) => {
		const read = readSkillFile(file);
		if ("error" in read)
			throw new PluginError(
				`config skills.packages: the skill file ${relativePath(dir, file)} of "${name}" cannot be read (${read.error}). Reinstall the package, or remove it from skills.packages.`,
			);
		try {
			checkSkillName(read.name);
		} catch (error) {
			throw new PluginError(
				`config skills.packages: "${name}" holds a skill that cannot be offered. ${(error as Error).message} Use another version of the package, or remove it from skills.packages.`,
			);
		}
		return { name: read.name, package: name, file };
	});
}

/**
 * The skills of installed npm packages, read from each package's `pi.skills` folders (Pi's
 * manifest). Throws a PluginError naming the fix when a package is not installed or has no
 * skills, or when two packages (or one package twice) offer the same name or a built-in name.
 * A clash with a linked or written skill is found by the registry, which holds those.
 */
export function discoverPackageSkills(
	packages: readonly string[],
	resolveDir: (name: string) => string = packageDir,
): PackageSkill[] {
	const found = new Map<string, PackageSkill>();
	for (const name of new Set(packages))
		for (const skill of packageSkillsOf(name, resolveDir)) {
			const earlier = found.get(skill.name);
			if (earlier)
				throw new PluginError(
					`config skills.packages: the skill "${skill.name}" comes from both "${earlier.package}" and "${skill.package}". Drop one of the packages from skills.packages.`,
				);
			if ((BUILTIN_SKILLS as readonly string[]).includes(skill.name))
				throw new PluginError(
					`config skills.packages: the skill "${skill.name}" of "${skill.package}" has the name of a built-in skill. Drop the package from skills.packages.`,
				);
			found.set(skill.name, skill);
		}
	// pi-lens-ignore: no-sort-without-comparator — skill names sort by code unit, the same order on every machine
	return [...found.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}
