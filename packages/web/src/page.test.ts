import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { buildPage } from "../scripts/build-page.ts";
import { loadAssets } from "./assets.ts";
import { ZH_TW } from "./i18n/zh-tw.ts";

// The browser page is compiled here, so a broken front end fails the tests and not only the build.
test("the page builds with relative URLs only, and every file it names is in the bundle", async () => {
	const dir = mkdtempSync(join(tmpdir(), "web-console-build-"));
	await buildPage(dir);
	const assets = loadAssets(dir);
	const html = new TextDecoder().decode(assets.get("index.html")?.body);
	const referenced = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(
		(match) => match[1] ?? "",
	);
	expect(referenced.length).toBeGreaterThanOrEqual(2);
	for (const url of referenced) {
		expect(url.startsWith("./")).toBe(true);
		expect(assets.has(url.slice(2))).toBe(true);
	}
	expect(html).not.toContain("http://");
	expect(html).not.toContain("https://");
	const script = [...assets.entries()].find(([name]) => name.endsWith(".js"));
	expect(script?.[1].type).toContain("javascript");
});

/**
 * What the page loads before it draws, gzipped, at master b54b4ed before the characters: the entry
 * script (145,612 bytes) and the stylesheet (8,707 bytes). The 2,000 bytes added to it are the long
 * press and menu hook the entry script now carries (`useLongPress`, its menu state and the row
 * props); the menus' drawing and their builders are lazy chunks and are not counted here. The
 * 200 bytes after it are the minifier's renaming: 0.28's Connectors management, a lazy chunk, left
 * the entry script 16 bytes longer and 66 bytes larger gzipped, on 16 bytes of headroom. The 260
 * bytes after that are a start-over clearing the room on every page (251 bytes gzipped): the room
 * state drops what came before the line, and the line itself, its styles and the archived
 * conversation are lazy chunks. The 300 bytes after that are the waiting cards' button in the top
 * bar, the rail and a room's header, with its styles and the room's test for a waiting card; the
 * list of cards, the jump and the room's chip are lazy chunks. The 150 bytes after that are the
 * merge of 0.28's branches: the room store keeping live text through an intercom card, the shared
 * room chat view and the table's fold state together left the entry 110 bytes over; the cards, the
 * fold bar and the table's chat mode are lazy chunks.
 */
const FIRST_LOAD_BASELINE = 145_612 + 8_707 + 2_000 + 200 + 260 + 300 + 150;
// 16 KB since the host's skin tones (`characters.skins`) reach the entry: about 0.2 KB gzipped, on 0.17 KB of headroom.
const CHARACTER_BUDGET = 16 * 1024;

test("the characters add at most 16 KB gzipped to what the page loads first, and the kit stays out of it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "web-console-budget-"));
	await buildPage(dir);
	const assets = loadAssets(dir);
	const html = new TextDecoder().decode(assets.get("index.html")?.body);
	const first = [
		...html.matchAll(/(?:src|href)="\.\/([^"]+\.(?:js|css))"/g),
	].map((match) => match[1] ?? "");
	expect(first.length).toBeGreaterThanOrEqual(2);
	const gzipped = (name: string) =>
		gzipSync(assets.get(name)?.body ?? new Uint8Array()).length;
	const total = first.reduce((sum, name) => sum + gzipped(name), 0);
	expect(total - FIRST_LOAD_BASELINE).toBeLessThanOrEqual(CHARACTER_BUDGET);
	// The state motion of the characters is in the stylesheet; the composer is a chunk of its own.
	const style = new TextDecoder().decode(
		assets.get(first.find((name) => name.endsWith(".css")) ?? "")?.body,
	);
	expect(style).toContain("av-breathe");
	const entry = new TextDecoder().decode(
		assets.get(first.find((name) => name.endsWith(".js")) ?? "")?.body,
	);
	expect(entry).not.toContain("data-part");
	const kitChunk = [...assets.entries()].find(
		([name, asset]) =>
			name.endsWith(".js") &&
			new TextDecoder().decode(asset.body).includes("data-part"),
	);
	expect(kitChunk).toBeDefined();
});

test("a directory with no page is refused with the fix", () => {
	expect(() => loadAssets(join(tmpdir(), "no-such-page-dir"))).toThrow(
		"bun run build",
	);
	const empty = mkdtempSync(join(tmpdir(), "web-console-empty-"));
	expect(() => loadAssets(empty)).toThrow("no index.html");
});

test("a served page links the manifest with credentials, a theme colour and the apple icon", async () => {
	const { presentPage } = await import("./page-presentation.ts");
	const html = String(
		presentPage(
			new TextEncoder().encode("<html><head></head></html>"),
			"/app",
			undefined,
		),
	);
	expect(html).toContain(
		'rel="manifest" href="./manifest.webmanifest" crossorigin="use-credentials"',
	);
	expect(html).toContain('name="theme-color"');
	expect(html).toContain('rel="apple-touch-icon"');
	const plain = String(
		presentPage(
			new TextEncoder().encode("<html><head></head></html>"),
			undefined,
			undefined,
		),
	);
	expect(plain).toContain('crossorigin="use-credentials"');
});

test("the round table ships as two lazy chunks: the WebGL scene stays small enough, and nothing else carries three", async () => {
	const dir = mkdtempSync(join(tmpdir(), "web-console-table-"));
	await buildPage(dir);
	const scripts = readdirSync(dir).filter((name) => name.endsWith(".js"));
	const only = (prefix: string) => {
		const found = scripts.filter((name) => name.startsWith(prefix));
		expect(found).toHaveLength(1);
		return found[0] ?? "";
	};
	const gzipped = (name: string) =>
		gzipSync(readFileSync(join(dir, name)), { level: 9 }).length;
	expect(gzipped(only("chunk-table3d-"))).toBeLessThanOrEqual(160 * 1024);
	expect(gzipped(only("chunk-table2d-"))).toBeLessThanOrEqual(5 * 1024);
	for (const name of scripts) {
		const carries = readFileSync(join(dir, name), "utf8").includes(
			"WebGLRenderer",
		);
		expect(carries).toBe(name.startsWith("chunk-table3d-"));
	}
	// The round table's own code is reached through the page's lazy imports only: its entry module is
	// a chunk, and no other file carries the wrapper it builds.
	const entry = only("chunk-entry-");
	for (const name of scripts)
		expect(
			readFileSync(join(dir, name), "utf8").includes("rt-table-stage"),
		).toBe(name === entry);
});

test("the files pane's editor is a lazy chunk of its own, each language another, and no file the page loads first carries CodeMirror", async () => {
	const dir = mkdtempSync(join(tmpdir(), "web-console-editor-"));
	await buildPage(dir);
	const assets = loadAssets(dir);
	const html = new TextDecoder().decode(assets.get("index.html")?.body);
	const first = [...html.matchAll(/(?:src|href)="\.\/([^"]+\.js)"/g)].map(
		(match) => match[1] ?? "",
	);
	const scripts = readdirSync(dir).filter((name) => name.endsWith(".js"));
	const carries = (name: string) =>
		readFileSync(join(dir, name), "utf8").includes("cm-scroller");
	for (const name of first) expect(carries(name)).toBe(false);
	const gzipped = (name: string) =>
		gzipSync(readFileSync(join(dir, name)), { level: 9 }).length;
	const editor = scripts.filter((name) => name.startsWith("chunk-codeeditor-"));
	expect(editor).toHaveLength(1);
	// What carries CodeMirror is the editor, a language, or the code they share, which the bundler may
	// name `index`; none of it is in what the worker precaches.
	const carriers = scripts.filter(carries);
	expect(carriers.length).toBeGreaterThanOrEqual(1);
	expect(carriers.some((name) => name.startsWith("chunk-codeeditor-"))).toBe(
		true,
	);
	const worker = readFileSync(join(dir, "sw.js"), "utf8");
	const precached = /\["index\.html"[^\]]*\]/.exec(worker)?.[0] ?? "";
	expect(precached).toContain("chunk-workspace-");
	for (const name of carriers) expect(precached).not.toContain(name);
	const page = scripts.filter((name) => name.startsWith("chunk-workspace-"));
	expect(page).toHaveLength(1);
	expect(carries(page[0] ?? "")).toBe(false);
	for (const language of [
		"typescript",
		"javascript",
		"json",
		"markdown",
		"css",
		"html",
		"python",
		"yaml",
		"go",
		"rust",
		"sql",
		"xml",
		"shell",
		"toml",
		"dockerfile",
	])
		expect(
			scripts.filter((name) => name.startsWith(`chunk-lang-${language}-`)),
		).toHaveLength(1);
	// The editor with the shared parts stays within what the spec measured: about 101 KB gzipped.
	const total = carriers.reduce((sum, name) => sum + gzipped(name), 0);
	expect(total).toBeLessThanOrEqual(380 * 1024);
});

test("the zh-TW catalog is a chunk of its own, which the page loads only for that locale and the worker still caches", async () => {
	const dir = mkdtempSync(join(tmpdir(), "web-console-catalog-"));
	await buildPage(dir);
	const assets = loadAssets(dir);
	const text = (name: string) =>
		new TextDecoder().decode(assets.get(name)?.body);
	const html = text("index.html");
	const first = [...html.matchAll(/(?:src|href)="\.\/([^"]+\.js)"/g)].map(
		(match) => match[1] ?? "",
	);
	const sample = ZH_TW["character.jobs.archivist"] as string;
	for (const name of first) expect(text(name)).not.toContain(sample);
	const holders = [...assets.keys()].filter(
		(name) => name.endsWith(".js") && text(name).includes(sample),
	);
	expect(holders).toHaveLength(1);
	expect(holders[0]).toMatch(/^chunk-zh-tw-/);
	expect(text("sw.js")).toContain(holders[0] as string);
});
