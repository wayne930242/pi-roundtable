import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const HASHED = /-[a-z0-9]{6,}\.[a-z0-9]+$/;
// The round table's WebGL scene (three, about 150 KB gzip) is fetched when a table first opens and
// cached by the worker then, so a fresh install does not download it. The 2D table and the module
// that picks between the two are small and are precached. The files pane's editor (CodeMirror,
// about 100 KB gzip) and its language wrappers are the same: fetched when a file first opens.
// `web/sw.ts` keeps the same names in its `LAZY` pattern.
const NOT_PRECACHED = /^chunk-(table3d|codeeditor|lang-[a-z]+)-/;
/**
 * Whatever carries the editor stays out of the precache whatever the bundler named it: a module
 * the editor and a language wrapper both import may be hoisted into a chunk with no name of its own.
 * `cm-scroller` is a class name CodeMirror's base theme writes, which minifying leaves alone.
 */
const EDITOR_MARKER = "cm-scroller";

/**
 * Builds `web/index.html` and everything it imports into `outdir`, which it empties first, then
 * `web/sw.ts` into `outdir/sw.js` with the page's hashed files as its precache list.
 */
export async function buildPage(outdir: string): Promise<string[]> {
	rmSync(outdir, { recursive: true, force: true });
	const common = {
		outdir,
		// Named chunks, so the worker can tell the table's scene from the rest.
		naming: {
			chunk: "chunk-[name]-[hash].[ext]",
			entry: "[dir]/[name]-[hash].[ext]",
		},
		// Relative URLs, so the page works under whatever mount path the operator picks.
		publicPath: "./",
		minify: true,
		// The older panes load when first opened, as chunks of their own.
		splitting: true,
		target: "browser",
		define: { "process.env.NODE_ENV": JSON.stringify("production") },
		throw: false,
	} satisfies Partial<Bun.BuildConfig>;
	const page = await Bun.build({
		...common,
		entrypoints: [`${root}web/index.html`],
		// The page keeps its own file names; only `index.html` must stay unhashed.
		naming: { chunk: common.naming.chunk },
	});
	// The table's pages import `table/entry.ts` lazily, which splits out its two scenes as chunks.
	const result = page;
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
	const editor = new Set<string>();
	for (const output of result.outputs) {
		const file = relative(outdir, output.path).split(sep).join("/");
		if (file.endsWith(".js") && (await output.text()).includes(EDITOR_MARKER))
			editor.add(file);
	}
	const precache = [
		"index.html",
		...assets
			.filter((file) => !NOT_PRECACHED.test(file) && !editor.has(file))
			.sort(),
	];
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
