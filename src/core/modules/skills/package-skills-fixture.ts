import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { packageDir } from "../../shared/package-dir.ts";

/**
 * Installs a fake npm package under `<root>/node_modules` with the layout of `pi-aaaav`:
 * `"pi": { "skills": ["./skills"] }` and one folder with a SKILL.md per skill.
 */
export function installPackage(
	root: string,
	name: string,
	skills: Record<string, string>,
	manifest: Record<string, unknown> = { pi: { skills: ["./skills"] } },
): void {
	const dir = join(root, "node_modules", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name, version: "1.0.0", ...manifest }),
	);
	for (const [skill, description] of Object.entries(skills)) {
		mkdirSync(join(dir, "skills", skill, "playbooks"), { recursive: true });
		writeFileSync(
			join(dir, "skills", skill, "SKILL.md"),
			`---\nname: ${skill}\ndescription: ${description}\n---\n\n# ${skill}\n`,
		);
	}
}

/** Looks packages up from `<root>`, the way a host finds its own dependencies. */
export const packageDirIn = (root: string) => (name: string) =>
	packageDir(name, pathToFileURL(join(root, "host.js")));
