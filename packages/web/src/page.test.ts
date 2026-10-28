import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { buildPage } from "../scripts/build-page.ts";
import { loadAssets } from "./assets.ts";

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
 * script (145,612 bytes) and the stylesheet (8,707 bytes).
 */
const FIRST_LOAD_BASELINE = 145_612 + 8_707;
const CHARACTER_BUDGET = 15 * 1024;

test("the characters add at most 15 KB gzipped to what the page loads first, and the kit stays out of it", async () => {
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
