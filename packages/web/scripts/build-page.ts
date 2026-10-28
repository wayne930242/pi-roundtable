import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const HASHED = /-[a-z0-9]{6,}\.[a-z0-9]+$/;

/**
 * Builds `web/index.html` and everything it imports into `outdir`, which it empties first, then
 * `web/sw.ts` into `outdir/sw.js` with the page's hashed files as its precache list.
 */
export async function buildPage(outdir: string): Promise<string[]> {
	rmSync(outdir, { recursive: true, force: true });
	const result = await Bun.build({
		entrypoints: [`${root}web/index.html`],
		outdir,
		// Relative URLs, so the page works under whatever mount path the operator picks.
		publicPath: "./",
		minify: true,
		// The older panes load when first opened, as chunks of their own.
		splitting: true,
		target: "browser",
		define: { "process.env.NODE_ENV": JSON.stringify("production") },
		throw: false,
	});
	if (!result.success)
		throw new Error(
			`the console page did not build: ${result.logs.map((log) => log.message).join("; ")}`,
		);
	const files = result.outputs.map((output) =>
		relative(outdir, output.path).split(sep).join("/"),
	);
	const assets = files.filter((file) => file !== "index.html");
	const unhashed = assets.filter((file) => !HASHED.test(file));
	if (unhashed.length > 0)
		throw new Error(
			`the console page has files without a content hash, which the service worker cannot cache safely: ${unhashed.join(", ")}`,
		);
	const precache = ["index.html", ...assets.sort()];
	const worker = await Bun.build({
		entrypoints: [`${root}web/sw.ts`],
		outdir,
		naming: "sw.js",
		minify: true,
		target: "browser",
		define: {
			__PRECACHE__: JSON.stringify(precache),
			__VERSION__: JSON.stringify(
				createHash("sha256")
					.update(precache.join("\n"))
					.digest("hex")
					.slice(0, 12),
			),
		},
		throw: false,
	});
	if (!worker.success)
		throw new Error(
			`the service worker did not build: ${worker.logs.map((log) => log.message).join("; ")}`,
		);
	return [...result.outputs, ...worker.outputs].map((output) => output.path);
}
