import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	all,
	brief,
	editorView,
	go,
	holds,
	inEditor,
	page,
	query,
	settle,
	show,
	workspacePage,
} from "./workspace-fixture.tsx";

workspacePage();

test("a binary or too large file is a card with Download, and no editor", async () => {
	await show("#/workspace/agents%3Adata%2Fblob.bin");
	await settle(50);
	expect(brief(inEditor(".cm-editor"))).toBeUndefined();
	expect(query(".ws-card")?.textContent).toContain(
		"This file is not text, so it cannot be shown here.",
	);
	expect(query(".ws-card a")?.getAttribute("href")).toBe(
		"api/workspace/agents/raw?path=data%2Fblob.bin&download=1",
	);
	expect(query(".ws-actions button")?.textContent).not.toBe("Edit");
	expect(query(".badge")?.textContent).toContain("Read only");
	await show("#/workspace/agents%3Adata%2Fhuge.log");
	await settle(50);
	expect(query(".ws-card")?.textContent).toContain("too large");
});

test("a picture is shown from the raw route with a fit/full-size toggle, its size in the header, and no editor", async () => {
	await show("#/workspace/agents%3Apics%2Fa.png");
	await settle(50);
	const img = query<HTMLImageElement>(".ws-image img");
	expect(img?.getAttribute("src")).toBe(
		"api/workspace/agents/raw?path=pics%2Fa.png",
	);
	expect(brief(inEditor(".cm-editor"))).toBeUndefined();
	expect(query(".ws-file-title")?.textContent).toContain("2 KB");
	const toggle = query<HTMLButtonElement>(".ws-image-toggle");
	expect(query(".ws-image")?.hasAttribute("data-actual")).toBe(false);
	await page.click(toggle);
	expect(query(".ws-image")?.getAttribute("data-actual")).toBe("true");
	await page.act(() => {
		img?.dispatchEvent(new Event("error"));
	});
	expect(query(".ws-card")?.textContent).toContain(
		"This browser cannot show this file.",
	);
	expect(query(".ws-card a[download]")).not.toBeNull();
});

test("a svg is a picture through <img>, and Edit opens its source", async () => {
	await show("#/workspace/agents%3Apics%2Flogo.svg");
	await settle(50);
	expect(query(".ws-image img")).not.toBeNull();
	expect(brief(inEditor(".cm-editor"))).toBeUndefined();
	await page.click(query(".ws-actions button"));
	await editorView();
	expect(brief(query(".ws-image img"))).toBeUndefined();
});

test("a PDF is framed on a desktop, and on a phone is Open and Download", async () => {
	await show("#/workspace/agents%3Adocs%2Fa.pdf");
	await settle(50);
	expect(query("iframe.ws-pdf")?.getAttribute("src")).toBe(
		"api/workspace/agents/raw?path=docs%2Fa.pdf",
	);
	expect(query(".ws-media-actions a[target='_blank']")).not.toBeNull();
	await show("#/workspace/agents%3Adocs%2Fa.pdf", 390);
	await settle(50);
	expect(brief(query("iframe"))).toBeUndefined();
	expect(query(".ws-card")?.textContent).toContain("PDF");
	expect(query(".ws-media-actions a[target='_blank']")).not.toBeNull();
	expect(query(".ws-media-actions a[download]")).not.toBeNull();
});

test("a sound and a video get native controls on the raw route, and fall back to a card on error", async () => {
	await show("#/workspace/agents%3Aav%2Fa.mp3");
	await settle(50);
	const audio = query<HTMLAudioElement>("audio");
	expect(audio?.hasAttribute("controls")).toBe(true);
	expect(audio?.getAttribute("src")).toBe(
		"api/workspace/agents/raw?path=av%2Fa.mp3",
	);
	await show("#/workspace/agents%3Aav%2Fa.mp4");
	await settle(50);
	const video = query<HTMLVideoElement>("video");
	expect(video?.hasAttribute("controls")).toBe(true);
	expect(video?.hasAttribute("playsinline")).toBe(true);
	await page.act(() => {
		video?.dispatchEvent(new Event("error"));
	});
	expect(brief(query("video"))).toBeUndefined();
	expect(query(".ws-card a[download]")).not.toBeNull();
});

test("a read-only root offers no Edit and no way to make, rename or delete", async () => {
	await show("#/workspace/docs%3A");
	expect(brief(query("button[aria-label='New file']"))).toBeUndefined();
	expect(brief(query("button[aria-label='Trash']"))).toBeUndefined();
});

test("the editor's theme names no color of its own: every one is a CSS variable", () => {
	const source = readFileSync(
		new URL("./workspace/theme.ts", import.meta.url),
		"utf8",
	);
	expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
	expect(source).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
	expect(source).toContain("var(--code-keyword)");
	for (const name of [
		"code-bg",
		"code-fg",
		"code-gutter",
		"code-selection",
		"code-keyword",
		"code-string",
		"code-number",
		"code-comment",
		"code-type",
		"code-function",
		"code-meta",
	]) {
		for (const file of ["./tokens.css", "./styles/camelot.css"])
			expect(readFileSync(new URL(file, import.meta.url), "utf8")).toContain(
				`--${name}:`,
			);
	}
});

/** Goes to another place the way a link does, and lets the page settle. */

test("switching folders keeps the pane: the old rows stay, dimmed, until the new ones arrive, and no loading state shows in between", async () => {
	await show("#/workspace/agents%3Asrc%2F");
	const tree = query(".ws-tree");
	const names = () => all(".ws-row-link strong").map((one) => one.textContent);
	expect(names()).toEqual(["main.ts", "util.ts"]);
	// Every state the pane passes through is watched for the loading skeletons and the empty note.
	const blank: string[] = [];
	const watch = new MutationObserver(() => {
		if (query(".skeleton, .empty"))
			blank.push(brief(query(".skeleton, .empty")) ?? "");
	});
	watch.observe(page.container, { childList: true, subtree: true });
	let release = () => {};
	holds.list = new Promise<void>((done) => {
		release = done;
	});
	await go("#/workspace/agents%3Adata%2F");
	// The new place is named at once; its rows are on their way, and the old ones hold the room.
	expect(query(".ws-crumbs a[aria-current='page']")?.textContent).toBe("data");
	expect(names()).toEqual(["main.ts", "util.ts"]);
	expect(query(".ws-listing")?.hasAttribute("data-pending")).toBe(true);
	expect(query(".ws-listing")?.hasAttribute("inert")).toBe(true);
	expect(query(".ws-tree")).toBe(tree);
	holds.list = undefined;
	release();
	await settle(60);
	expect(names()).toEqual(["blob.bin", "huge.log"]);
	expect(query(".ws-listing")?.hasAttribute("data-pending")).toBe(false);
	expect(query(".ws-tree")).toBe(tree);
	watch.disconnect();
	expect(blank).toEqual([]);
});

test("a folder that was shown before shows at once on a return, and a branch of the tree opened again lists no placeholder", async () => {
	await show("#/workspace/agents%3Asrc%2F");
	await go("#/workspace/agents%3Adata%2F");
	// The listing for src is held back, as a slow connection would: it is on show from what was fetched before.
	let release = () => {};
	holds.list = new Promise<void>((done) => {
		release = done;
	});
	await go("#/workspace/agents%3Asrc%2F");
	expect(all(".ws-row-link strong").map((one) => one.textContent)).toEqual([
		"main.ts",
		"util.ts",
	]);
	expect(query(".ws-listing")?.hasAttribute("data-pending")).toBe(false);
	// Shut and open src in the tree: its rows are there on the same render, with no "…" note.
	holds.list = undefined;
	release();
	await settle(60);
	const twist = () => all(".ws-tree .ws-twist")[1] as HTMLElement;
	await page.click(twist());
	await settle(60);
	holds.list = new Promise<void>((done) => {
		release = done;
	});
	await page.click(twist());
	await page.click(twist());
	expect(query(".ws-tree .ws-tree-note")).toBeNull();
	expect(
		all(".ws-tree .ws-tree-row a").map((one) => one.textContent),
	).toContain("main.ts");
	holds.list = undefined;
	release();
	await settle(60);
});

test("a folder opens at its top, and the same folder fetched again does not move it", async () => {
	await show("#/workspace/agents%3Asrc%2F");
	const main = query<HTMLElement>(".ws-main");
	let scrolls = 0;
	if (main) main.scrollTo = (() => scrolls++) as typeof main.scrollTo;
	await go("#/workspace/agents%3Adata%2F");
	expect(scrolls).toBe(1);
	// A change that lists the folder again (a new file, the page regaining focus) leaves it where it is.
	await page.act(async () => {
		window.dispatchEvent(new Event("focus"));
	});
	await settle(60);
	expect(scrolls).toBe(1);
});
