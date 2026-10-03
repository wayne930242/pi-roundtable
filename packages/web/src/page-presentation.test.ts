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
test("default HTML remains byte-identical and path routing/locales fail fast on invalid settings", () => {
	expect(presentPage(page, undefined, undefined)).toEqual(page);
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
