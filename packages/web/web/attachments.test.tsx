import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { RoomFile, RoomMessage } from "../src/api-types.ts";
import { MessageRow } from "./components/message-row.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { loadBuiltInMessages, setPresentation } from "./lib/messages.ts";

const base = { title: "Console", panes: [] as never[], timeZone: "UTC" };

const file = (
	id: string,
	name: string,
	size: number,
	type = "application/pdf",
): RoomFile => ({
	id,
	name,
	type,
	size,
});

const message = (
	id: number,
	files: RoomFile[],
	text = "here they are",
): RoomMessage => ({
	id,
	room: "app:agent.scholar",
	kind: "agent",
	agent: "scholar",
	author: "Scholar",
	text,
	files,
	at: "2026-10-31T10:00:00.000Z",
});

const SEVEN = [
	file("f1", "paper-one.pdf", 1_250_000),
	file("f2", "paper-two.pdf", 980_000),
	file("f3", "data.zip", 4_400_000, "application/zip"),
	file("f4", "code.zip", 52_000, "application/zip"),
	file("f5", "appendix.pdf", 300_000),
	file("f6", "figures.zip", 2_100_000, "application/zip"),
	file("f7", "summary.md", 2_048, "text/markdown"),
];

let page: TestPage;
let realRect: HTMLElement["getBoundingClientRect"];
let bubbleHeight = 0;
beforeAll(async () => {
	page = await openPage();
	realRect = HTMLElement.prototype.getBoundingClientRect;
	// The test page lays nothing out: a bubble is as tall as each test says.
	HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
		const rect = realRect.call(this);
		return this.classList.contains("bubble")
			? ({ ...rect.toJSON(), height: bubbleHeight } as DOMRect)
			: rect;
	};
});
afterAll(async () => {
	HTMLElement.prototype.getBoundingClientRect = realRect;
	await page.unmount();
	await releaseDom();
});
afterEach(async () => {
	setPresentation(base);
	await loadBuiltInMessages(undefined);
	window.innerWidth = 1280;
	window.innerHeight = 800;
	bubbleHeight = 0;
});

const settle = (ms = 80) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

async function draw(shown: RoomMessage) {
	// A fresh row each time, so the bubble is measured as it mounts.
	await page.render(null);
	await page.render(
		<ol className="messages">
			<MessageRow
				message={shown}
				character={undefined}
				header
				enter={false}
				timeZone="UTC"
				quotable={false}
			/>
		</ol>,
	);
	// The block and the jump are a lazy chunk.
	await page.act(() => settle());
	const row = page.container.querySelector<HTMLElement>(
		`li[data-mid="${shown.id}"]`,
	);
	if (!row) throw new Error("the message was not drawn");
	return row;
}

test("a message's files sit in one block headed by their count, each chip with its icon, name and size", async () => {
	const row = await draw(message(1, SEVEN));
	const block = row.querySelector(".bubble > .attachments");
	expect(block?.querySelector(".attachments-head span")?.textContent).toBe(
		"Attachments (7)",
	);
	const chips = [...(block?.querySelectorAll(".file-chip") ?? [])];
	expect(chips).toHaveLength(7);
	expect(chips[0]?.querySelector("svg")).not.toBeNull();
	expect(chips[0]?.querySelector(".file-name")?.textContent).toBe(
		"paper-one.pdf",
	);
	expect(chips[0]?.querySelector(".file-size")?.textContent).toBe("1.2 MB");
	expect(chips[6]?.querySelector(".file-size")?.textContent).toBe("2 KB");
	expect(chips[6]?.getAttribute("href")).toBe("api/files/f7");
	// The block comes after the text, never as inline code inside it.
	expect(row.querySelector(".bubble code")).toBeNull();
});

test("two or more files offer one zip of them all; a single file does not", async () => {
	const many = await draw(message(2, SEVEN.slice(0, 2)));
	const all = many.querySelector<HTMLAnchorElement>(".attachments-head a");
	expect(all?.textContent).toBe("Download all");
	expect(all?.getAttribute("href")).toBe(
		"api/files/zip?room=app%3Aagent.scholar&message=2",
	);
	expect(all?.hasAttribute("download")).toBe(true);
	const one = await draw(message(3, SEVEN.slice(0, 1)));
	expect(one.querySelector(".attachments-head span")?.textContent).toBe(
		"Attachments (1)",
	);
	expect(one.querySelector(".attachments-head a")).toBeNull();
	const none = await draw(message(4, []));
	expect(none.querySelector(".attachments")).toBeNull();
	expect(none.querySelector(".attachments-jump")).toBeNull();
});

test("a bubble taller than the screen opens with a jump to its attachments; a short one does not", async () => {
	window.innerHeight = 844;
	bubbleHeight = 300;
	const short = await draw(message(5, SEVEN));
	expect(short.querySelector<HTMLElement>(".attachments-jump")?.hidden).toBe(
		true,
	);
	bubbleHeight = 1500;
	const tall = await draw(message(6, SEVEN, "a long reply"));
	const jump = tall.querySelector<HTMLButtonElement>(".attachments-jump");
	expect(jump?.hidden).toBe(false);
	expect(jump?.textContent).toBe("📎 7 attachments");
	// It is the bubble's first line, before the text.
	expect(tall.querySelector(".bubble")?.firstElementChild).toBe(jump ?? null);
	let target: Element | undefined;
	let how: ScrollIntoViewOptions | undefined;
	const real = Element.prototype.scrollIntoView;
	Element.prototype.scrollIntoView = function (this: Element, options) {
		target = this;
		how = options as ScrollIntoViewOptions;
	};
	try {
		await page.act(async () => {
			jump?.click();
			await settle(10);
		});
	} finally {
		Element.prototype.scrollIntoView = real;
	}
	expect(target).toBe(tall.querySelector(".attachments") ?? undefined);
	expect(how?.block).toBe("start");
});

test("on a 390px phone the block keeps every chip on a row of its own, its name cut before its size", async () => {
	window.innerWidth = 390;
	window.innerHeight = 844;
	bubbleHeight = 1500;
	const row = await draw(message(7, SEVEN));
	const block = row.querySelector(".attachments");
	expect(block?.querySelectorAll(".files > li")).toHaveLength(7);
	expect(row.querySelector<HTMLElement>(".attachments-jump")?.hidden).toBe(
		false,
	);
	const css = [...document.adoptedStyleSheets]
		.flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText))
		.join("\n");
	expect(css).toMatch(/\.attachments \.files\s*\{[^}]*flex-direction: column/);
	expect(css).toMatch(
		/\.attachments \.file-name\s*\{[^}]*text-overflow: ellipsis/,
	);
	expect(css).toMatch(/\.attachments \.file-size\s*\{[^}]*flex-shrink: 0/);
	const chip = block?.querySelector(".file-chip");
	expect(
		[...(chip?.children ?? [])].map(
			(child) => child.getAttribute("class") ?? "",
		),
	).toEqual(["", "file-name", "file-size"]);
});

test("the block and the jump read in Traditional Chinese on a zh-TW page", async () => {
	await loadBuiltInMessages("zh-TW");
	setPresentation({ ...base, locale: "zh-TW" });
	bubbleHeight = 2000;
	const row = await draw(message(8, SEVEN));
	expect(row.querySelector(".attachments-head span")?.textContent).toBe(
		"附件（7）",
	);
	expect(row.querySelector(".attachments-head a")?.textContent).toBe(
		"全部下載",
	);
	expect(row.querySelector(".attachments-jump")?.textContent).toBe(
		"📎 7 個附件",
	);
});
