import { afterAll, beforeAll, expect, test } from "bun:test";
import { DISPLAY_KINDS } from "pi-better-show";
import { MessageMarkdown } from "./components/message-markdown.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { BLOCK_HINT } from "./lib/block-hint.ts";
import { setTheme } from "./lib/theme.ts";

let page: TestPage;
beforeAll(async () => {
	page = await openPage();
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});

const settle = (ms = 60) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One valid block of each kind the app draws, by the element that draws it. */
const SAMPLES: Record<string, { tag: string; source: string }> = {
	alert: {
		tag: "pbs-callout",
		source: "> [!WARNING] Heads up\n> This **overwrites** the cache.",
	},
	cards: {
		tag: "pbs-cards",
		source: "```cards\n- {title: Speed, tone: ok, body: 2x faster}\n```",
	},
	mermaid: {
		tag: "pbs-diagram",
		source: "```mermaid\ngraph TD\n  A[Start] --> B[Done]\n```",
	},
	mindmap: {
		tag: "pbs-mindmap",
		source: "```mindmap\n- Release\n  - Build\n  - Ship\n```",
	},
	diff: {
		tag: "pbs-diff",
		source: "```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n```",
	},
	table: {
		tag: "pbs-table",
		source: "```table\ncolumns: [name, size]\nrows:\n  - [alpha, 1204]\n```",
	},
	steps: {
		tag: "pbs-steps",
		source: "```steps\nitems:\n  - {title: Design, status: done}\n```",
	},
	stats: {
		tag: "pbs-stats",
		source: "```stats\n- {label: Users, value: '1,204'}\n```",
	},
};

async function draw(source: string): Promise<HTMLElement> {
	// The blocks are a lazy chunk; once it is loaded a message draws within a few ticks, load or not.
	await import("./components/blocks.tsx");
	await page.render(<MessageMarkdown source={source} />);
	await page.act(() => settle());
	return page.container;
}

test("the app declares exactly the kinds the page draws", () => {
	expect(Object.keys(SAMPLES).sort()).toEqual([...DISPLAY_KINDS].sort());
	for (const kind of DISPLAY_KINDS)
		expect(BLOCK_HINT.test(SAMPLES[kind]?.source ?? "")).toBe(true);
});

for (const kind of DISPLAY_KINDS) {
	test(`a ${kind} block in a message is drawn by its element, not shown as code`, async () => {
		const sample = SAMPLES[kind];
		if (!sample) throw new Error(kind);
		const root = await draw(`Before.\n\n${sample.source}\n\nAfter.`);
		const element = root.querySelector(sample.tag);
		expect(element).not.toBeNull();
		expect(element?.getAttribute("density")).toBe("compact");
		expect(root.querySelector("pre")).toBeNull();
		const text = root.textContent ?? "";
		expect(text.indexOf("Before.")).toBeLessThan(text.length);
		const paragraphs = [...root.querySelectorAll("p")].map(
			(p) => p.textContent,
		);
		expect(paragraphs).toContain("Before.");
		expect(paragraphs).toContain("After.");
		// Order is kept: the block sits between the two paragraphs.
		const kids = [...(root.querySelector(".prose")?.children ?? [])];
		const at = kids.findIndex(
			(child) => child.querySelector(sample.tag) || child.matches(sample.tag),
		);
		expect(at).toBe(1);
	});
}

test("a block whose YAML does not parse stays the code block it was, with the reason under it", async () => {
	const root = await draw("```table\ncolumns: [unclosed\n```");
	expect(root.querySelector("pbs-table")).toBeNull();
	expect(root.querySelector("pre")?.textContent).toContain(
		"columns: [unclosed",
	);
	expect(
		root.querySelector(".block-error")?.textContent?.length,
	).toBeGreaterThan(0);
});

test("a fence that is not closed yet stays a code block until it is", async () => {
	const open = "Working.\n\n```cards\n- {title: Speed, body: 2x";
	const root = await draw(open);
	expect(root.querySelector("pbs-cards")).toBeNull();
	expect(root.querySelector("pre")?.textContent).toContain("title: Speed");
	expect(root.querySelector(".block-error")).toBeNull();
	// The rest arrives and the same message becomes a panel.
	const closed = `${open}}\n\`\`\``;
	const after = await draw(closed);
	expect(after.querySelector("pbs-cards")).not.toBeNull();
	expect(after.querySelector("pre")).toBeNull();
});

test("a kind the app does not draw, and an ordinary code fence, stay code blocks", async () => {
	const root = await draw(
		"```options\n- title: A\n- title: B\n```\n\n```ts\nconst x = 1;\n```",
	);
	expect(root.querySelectorAll("pre")).toHaveLength(2);
	expect(root.querySelector("[class*='pbs']")).toBeNull();
	expect(root.querySelector("pbs-options")).toBeNull();
});

test("a message without a block never loads the blocks", async () => {
	expect(BLOCK_HINT.test("A table: | a | b |\n|---|---|\n| 1 | 2 |")).toBe(
		false,
	);
	expect(BLOCK_HINT.test("```ts\nconst cards = 1;\n```")).toBe(false);
	expect(BLOCK_HINT.test("> a plain quote")).toBe(false);
	const root = await draw("Just **words**.");
	expect(root.querySelector("strong")?.textContent).toBe("words");
	expect(root.querySelector("pbs-cards")).toBeNull();
});

test("a diagram asks the app's own route for its image, in the colours of the console's scheme", async () => {
	await page.act(() => setTheme("light"));
	const root = await draw(SAMPLES.mermaid?.source ?? "");
	const diagram = root.querySelector("pbs-diagram") as HTMLElement | null;
	const image = diagram?.shadowRoot?.querySelector("img");
	const light = image?.getAttribute("src") ?? "";
	expect(light).toStartWith("api/diagram?scheme=light&s=");
	const encoded =
		new URL(light, "http://localhost/").searchParams.get("s") ?? "";
	expect(Buffer.from(encoded, "base64url").toString("utf8")).toBe(
		"graph TD\n  A[Start] --> B[Done]",
	);
	// A theme change redraws the element with the other scheme.
	await page.act(() => setTheme("dark"));
	// Where the browser has view transitions the scheme changes a frame later.
	for (
		let tries = 0;
		tries < 40 && diagram?.getAttribute("scheme") !== "dark";
		tries++
	)
		await page.act(() => settle());
	expect(diagram?.getAttribute("scheme")).toBe("dark");
	expect(
		diagram?.shadowRoot?.querySelector("img")?.getAttribute("src"),
	).toStartWith("api/diagram?scheme=dark&s=");
	await page.act(() => setTheme("system"));
});

test("a diagram over 8 KB is not requested: the element shows its source", async () => {
	const big = `graph TD\n${"  A --> B\n".repeat(900)}`;
	const root = await draw(`\`\`\`mermaid\n${big}\`\`\``);
	const diagram = root.querySelector("pbs-diagram") as HTMLElement | null;
	expect(diagram).not.toBeNull();
	expect(diagram?.shadowRoot?.querySelector("img")).toBeNull();
});
