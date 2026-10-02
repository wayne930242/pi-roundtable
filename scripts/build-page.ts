import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Builds `web/index.html` and everything it imports into `outdir`, which it empties first. */
export async function buildPage(outdir: string): Promise<string[]> {
	rmSync(outdir, { recursive: true, force: true });
	const result = await Bun.build({
		entrypoints: [`${root}web/index.html`],
		outdir,
		// Relative URLs, so the page works under whatever mount path the operator picks.
		publicPath: "./",
		minify: true,
		target: "browser",
		define: { "process.env.NODE_ENV": JSON.stringify("production") },
		throw: false,
	});
	if (!result.success)
		throw new Error(
			`the console page did not build: ${result.logs.map((log) => log.message).join("; ")}`,
		);
	return result.outputs.map((output) => output.path);
}
