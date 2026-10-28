import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
