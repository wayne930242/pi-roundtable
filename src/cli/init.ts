import { existsSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { type BunFacts, checkBun } from "./checks/bun.ts";
import { type Rendered, renderProject, writeRendered } from "./templates.ts";

export interface InitInputs {
	cwd: string;
	/** The directory to create the project in, relative to `cwd`; default `cwd` itself. */
	dir?: string;
	bun: BunFacts;
	/** The exact version of pi-roundtable the project pins. */
	version: string;
	/** Where the templates are; default the package's own. */
	templates?: string;
}

export interface InitReport {
	ok: boolean;
	/** Why nothing was written, when `ok` is false. */
	problems: string[];
	/** Paths written, relative to the project directory. */
	created: string[];
	/** The project directory. */
	root: string;
	nextSteps: string[];
}

/** A package name npm accepts, from a directory's name. */
function projectName(root: string): string {
	const name = basename(root)
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return name === "" ? "roundtable-bot" : name;
}

function nextSteps(cwd: string, root: string): string[] {
	const where = relative(cwd, root);
	return [
		`${where === "" ? "" : `cd ${where} && `}bun install, then copy .env.example to .env and fill in the credentials it lists`,
		"bunx roundtable doctor: it lists what is still missing and how to fix it",
		"bunx roundtable start",
	];
}

/**
 * Creates a project. Every refusal is decided before the first write: Bun missing or too old,
 * or any file it would create already there.
 */
export function init(inputs: InitInputs): InitReport {
	const root = resolve(inputs.cwd, inputs.dir ?? ".");
	const refused = (problems: string[]): InitReport => ({
		ok: false,
		problems,
		created: [],
		root,
		nextSteps: [],
	});
	const bun = checkBun(inputs.bun);
	if (bun.status === "fail") return refused([bun.problem, bun.fix]);
	const files: Rendered[] = renderProject(
		{ project: projectName(root), version: inputs.version },
		inputs.templates,
	);
	const existing = files
		.map((file) => file.path)
		.filter((path) => existsSync(join(root, path)));
	if (existing.length > 0)
		return refused([
			`${existing.length === 1 ? "A file" : "Files"} init would create already exist in ${root}:`,
			...existing.map((path) => `  ${path}`),
			"Remove them or run init in an empty directory; nothing was written.",
		]);
	writeRendered(root, files);
	return {
		ok: true,
		problems: [],
		created: files.map((file) => file.path),
		root,
		nextSteps: nextSteps(inputs.cwd, root),
	};
}
