import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fail, ok, type Result, skipped } from "../report.ts";

/** The variables `.env.example` asks for: its uncommented `NAME=` lines. */
export function requiredVariables(example: string): string[] {
	return [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(
		(match) => match[1] as string,
	);
}

/** Every variable `.env.example` lists has a value, so a missing credential is named before anything tries to use it. */
export function checkEnvironment(
	cwd: string,
	env: Record<string, string | undefined>,
): Result {
	const path = join(cwd, ".env.example");
	if (!existsSync(path)) return skipped("this project has no .env.example");
	const missing = requiredVariables(readFileSync(path, "utf8")).filter(
		(name) => (env[name] ?? "").trim() === "",
	);
	if (missing.length === 0) return ok(".env has a value for every variable");
	return fail(
		`no value for ${missing.join(", ")}.`,
		`${existsSync(join(cwd, ".env")) ? "Fill them in .env" : "Copy .env.example to .env and fill them in"}; .env.example says where each one comes from.`,
	);
}
