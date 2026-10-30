import { expect, test } from "bun:test";
import { resolveOptions } from "./options.ts";
import { presentPage } from "./page-presentation.ts";
import { admit } from "./verifier.ts";

const page = new TextEncoder().encode(
	'<!doctype html><html lang="en"><head><title>Console</title></head><body></body></html>',
);
test("localized HTML bootstrap is inert and attribute escaped, including replacement tokens", () => {
	const html = String(
		presentPage(page, "/console", {
			locale: "fr",
			messages: { "Start over": '"><script>alert(1)</script>$&' },
		}),
	);
	expect(html).toContain('<base href="/console/">');
	expect(html).toContain('<html lang="fr">');
	expect(html).toContain('name="roundtable-console-presentation"');
	expect(html).toContain("&lt;script&gt;");
	expect(html).toContain("$&");
	expect(html).not.toContain("<script>");
});
test("default HTML only gains the install tags, and path routing/locales fail fast on invalid settings", () => {
	const plain = String(presentPage(page, undefined, undefined));
	expect(
		plain.replace(
			/<link rel="manifest"[^>]*>(<meta[^>]*>|<link[^>]*>)*<script[^>]*><\/script>/,
			"",
		),
	).toBe(new TextDecoder().decode(page));
	const base = {
		verifier: admit,
		origin: "https://console.example.test",
		panes: ["overview" as const],
	};
	expect(() =>
		resolveOptions({ ...base, presentation: { locale: "invalid_locale" } }),
	).toThrow("valid locale");
	expect(() =>
		resolveOptions({ ...base, routing: "invalid" as never }),
	).toThrow("routing");
});

test("under path routing the icon links follow the base, so they resolve under the mount; an empty description is refused", () => {
	const html = String(
		presentPage(page, "/console", undefined, "modern", {
			title: "Team",
			description: "About the team",
			origin: "https://console.example.test",
			mount: "/console",
			svg: true,
		}),
	);
	expect(html.indexOf("<base ")).toBeLessThan(html.indexOf('rel="icon"'));
	expect(html).toContain("<title>Team</title>");
	expect(() =>
		resolveOptions({
			verifier: admit,
			origin: "https://console.example.test",
			panes: ["overview"],
			description: "  ",
		}),
	).toThrow("description is empty");
});

test("under path routing the install links follow the base, so a deep room URL still finds the manifest and the touch icon", () => {
	const html = String(presentPage(page, "/app", undefined));
	const base = html.indexOf('<base href="/app/">');
	expect(base).toBeGreaterThan(-1);
	expect(html.indexOf('rel="manifest"')).toBeGreaterThan(base);
	expect(html.indexOf('rel="apple-touch-icon"')).toBeGreaterThan(base);
	const at = new URL("https://example.test/app/room/app:agent.guide");
	const resolved = new URL("/app/", at);
	expect(new URL("./manifest.webmanifest", resolved).pathname).toBe(
		"/app/manifest.webmanifest",
	);
});
