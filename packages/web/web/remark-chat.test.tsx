import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageMarkdown } from "./components/message-markdown.tsx";

/** The rendered message, without the newlines the renderer puts between elements. */
const html = (source: string): string =>
	renderToStaticMarkup(<MessageMarkdown source={source} />).replace(
		/>\n/g,
		">",
	);

test("a line that starts with -# is subtext, its own quiet paragraph", () => {
	expect(html("Pushed.\n-# Your own repository, no approval needed.")).toBe(
		'<div class="prose"><p>Pushed.</p><p class="subtext">Your own repository, no approval needed.</p></div>',
	);
	expect(html("-# **bold** note")).toBe(
		'<div class="prose"><p class="subtext"><strong>bold</strong> note</p></div>',
	);
});

test("subtext lines in a row stay one paragraph, and plain lines after them start another", () => {
	expect(html("-# one\n-# two\nback to plain")).toBe(
		'<div class="prose"><p class="subtext">one<br/>two</p><p>back to plain</p></div>',
	);
});

test("a single line break stays a line break, as Discord shows it", () => {
	expect(html("**Commits (1)**\nfirst\nsecond")).toBe(
		'<div class="prose"><p><strong>Commits (1)</strong><br/>first<br/>second</p></div>',
	);
});

test("-# inside code, in the middle of a line, or without its space is left as written", () => {
	expect(html("```\n-# kept\n```")).toContain("-# kept");
	expect(html("`-# kept`")).toContain("<code>-# kept</code>");
	expect(html("a -# b")).toBe('<div class="prose"><p>a -# b</p></div>');
	expect(html("-#tight")).toBe('<div class="prose"><p>-#tight</p></div>');
});

test("headings and lists are untouched", () => {
	expect(html("# Title\n- item")).toBe(
		'<div class="prose"><h1>Title</h1><ul><li>item</li></ul></div>',
	);
});
