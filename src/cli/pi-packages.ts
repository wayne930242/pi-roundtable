import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { packageDir } from "../core/shared/package-dir.ts";

/** What `add package` asks of the world outside the project's files; tests replace both. */
export interface PackagePorts {
	/** Installs `spec` into the project at `cwd`, as `bun add` does. */
	install(cwd: string, spec: string): Promise<{ ok: boolean; output: string }>;
	/**
	 * The tools the Pi extensions of the installed package `name` register when they load, looked
	 * up from the project at `cwd`. Throws when the package has no Pi extension or one fails to load.
	 */
	tools(cwd: string, name: string): Promise<string[]>;
}

async function bunAdd(cwd: string, spec: string) {
	const child = Bun.spawn(["bun", "add", spec], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { ok: code === 0, output: `${stdout}${stderr}`.trim() };
}

/** Whether the package says it holds Pi extensions: a `pi.extensions` list, or an `extensions` folder. */
function declaresExtensions(dir: string): boolean {
	const manifest: { pi?: { extensions?: unknown } } = JSON.parse(
		readFileSync(join(dir, "package.json"), "utf8"),
	);
	const listed = manifest.pi?.extensions;
	return Array.isArray(listed)
		? listed.length > 0
		: existsSync(join(dir, "extensions"));
}

/**
 * Loads the package's extensions as a session would, from an empty Pi agent directory so no
 * extension of the user's own joins in, and keeps only the ones inside the package.
 */
async function registeredTools(cwd: string, name: string): Promise<string[]> {
	const dir = packageDir(name, join(cwd, "package.json"));
	// Pi would load a plain package's index file as an extension; a library is not a Pi package.
	if (!declaresExtensions(dir))
		throw new Error(
			`${name} is not a Pi package: its package.json lists no extensions under "pi", and it has no extensions folder.`,
		);
	const agentDir = mkdtempSync(join(tmpdir(), "roundtable-package-"));
	try {
		const loaded = await discoverAndLoadExtensions([dir], cwd, agentDir);
		const failed = loaded.errors.filter((error) => error.path.startsWith(dir));
		if (failed.length > 0)
			throw new Error(
				`${name} failed to load: ${failed.map((error) => error.error).join("; ")}`,
			);
		const own = loaded.extensions.filter((extension) =>
			`${extension.resolvedPath}${sep}`.startsWith(`${dir}${sep}`),
		);
		if (own.length === 0)
			throw new Error(`${name} declares Pi extensions, but none loaded.`);
		return [
			...new Set(own.flatMap((extension) => [...extension.tools.keys()])),
		];
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
}

/** The real installer and loader. */
export const piPackagePorts: PackagePorts = {
	install: bunAdd,
	tools: registeredTools,
};
