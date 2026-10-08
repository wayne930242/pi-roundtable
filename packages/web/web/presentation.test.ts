import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Cleanup } from "./components/cleanup.tsx";
import { MarkdownDocument } from "./components/markdown.tsx";
import { ConfigContext } from "./lib/config.ts";
import { setPresentation, translate } from "./lib/messages.ts";
import { Whose } from "./pages/notes.tsx";

test("skill Markdown renders headings/emphasis/GFM tables and escapes HTML, scripts, local links and image fetches", () => {
	const html = renderToStaticMarkup(
		createElement(MarkdownDocument, {
			source:
				"# Heading\n\n**bold** `code`\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1)) [local](./secret) [web](https://example.test/docs)\n\n![image](https://example.test/image.png)",
		}),
	);
	expect(html).toContain("<h1>Heading</h1>");
	expect(html).toContain("<strong>bold</strong>");
	expect(html).toContain("<table>");
	expect(html).toContain("&lt;script&gt;");
	expect(html).not.toContain("<script>");
	expect(html).not.toContain("javascript:");
	expect(html).not.toContain('href="./secret"');
	expect(html).not.toContain("<img");
	expect(html).toContain(
		'href="https://example.test/docs" target="_blank" rel="noreferrer"',
	);
});

test("cleanup actions use host translations without interpreting hostile labels as HTML", () => {
	setPresentation({
		title: "Console",
		panes: ["overview"],
		timeZone: "UTC",
		messages: {
			"Start over": "Restart translated",
			Delete: "Delete translated",
		},
	});
	const config = {
		title: "Console",
		panes: ["overview" as const],
		timeZone: "UTC",
		cleanup: true,
	};
	const html = renderToStaticMarkup(
		createElement(
			ConfigContext.Provider,
			{ value: config },
			createElement(Cleanup, {
				channel: "discord:900000000000000001",
				title: "<script>bad</script>",
				busy: false,
				deletable: true,
				refresh: () => undefined,
			}),
		),
	);
	expect(html).toContain("Restart translated");
	expect(html).toContain("Delete translated");
	expect(html).not.toContain("<script>");
	expect(translate("Absent {count}", { count: 3 })).toBe("Absent 3");
	setPresentation({ title: "Console", panes: [], timeZone: "UTC" });
});

test("the notes pane names whose notes it shows, the visitor's own by default", () => {
	setPresentation({ title: "Console", panes: ["notes"], timeZone: "UTC" });
	const people = {
		self: "p_bea",
		principals: [
			{ id: "p_bea", name: "Bea" },
			{ id: "owner", name: "Owner" },
			{ id: "p_gus", name: "Gus", disabled: true as const },
		],
	};
	const own = renderToStaticMarkup(
		createElement(Whose, { people, shown: undefined, choose: () => {} }),
	);
	expect(own).toContain("Whose notes");
	expect(own).toContain('<option value="p_bea" selected="">Bea (you)</option>');
	expect(own).toContain('<option value="owner">Owner</option>');
	expect(own).toContain("Gus (disabled)");
	const theirs = renderToStaticMarkup(
		createElement(Whose, { people, shown: "owner", choose: () => {} }),
	);
	expect(theirs).toContain('<option value="owner" selected="">Owner</option>');
});
