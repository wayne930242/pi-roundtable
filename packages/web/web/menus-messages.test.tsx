import { expect, test } from "bun:test";
import type { PromptFrame, RoomFile } from "../src/api-types.ts";
import { ActionMenuHost } from "./components/action-menu.tsx";
import { PromptCard } from "./components/cards.tsx";
import { SelectTextSheetHost } from "./components/select-text-sheet.tsx";
import { closeMenu } from "./lib/action-menu.ts";
import { currentAgentSheet } from "./lib/agent-sheet.ts";
import { ConfigContext } from "./lib/config.ts";
import { draftOf } from "./lib/drafts.ts";
import { closeSelectText } from "./lib/message-sheets.ts";
import {
	choose,
	config,
	copied,
	labels,
	Message,
	menusPage,
	page,
	q,
	rightClick,
	SCOUT,
	said,
	settle,
	shown,
} from "./menus-fixture.tsx";

menusPage();

test("a message's menu: copy, copy as Markdown, quote, select, and share when the browser can", async () => {
	await page.render(<Message />);
	await rightClick(q("li.message"));
	expect(labels()).toEqual([
		"Copy",
		"Copy as Markdown",
		"Quote reply",
		"Select text",
	]);
	await page.act(() => closeMenu());
	Object.defineProperty(navigator, "share", {
		value: () => Promise.resolve(),
		configurable: true,
	});
	await rightClick(q("li.message"));
	expect(labels()).toEqual([
		"Copy",
		"Copy as Markdown",
		"Quote reply",
		"Select text",
		"Share",
	]);
	expect(q("li.message")?.getAttribute("data-hold")).toBe("text");
});

test("Copy puts the message's words on the clipboard; Copy as Markdown puts its source", async () => {
	const written = copied();
	await page.render(<Message />);
	await rightClick(q("li.message"));
	await choose("Copy");
	expect(written[0]).toContain("hello bold");
	expect(written[0]).not.toContain("**");
	await rightClick(q("li.message"));
	await choose("Copy as Markdown");
	expect(written[1]).toBe("hello **bold**\nsecond line");
});

test("Quote reply puts the message as a quote into the room's message box, below what is there", async () => {
	await page.render(<Message composer />);
	const box = q<HTMLTextAreaElement>("textarea");
	await rightClick(q("li.message"));
	await choose("Quote reply");
	expect(draftOf(SCOUT)).toBe("> hello **bold**\n> second line\n\n");
	expect(box?.value).toBe("> hello **bold**\n> second line\n\n");
	expect(document.activeElement).toBe(box);

	await page.act(() => {
		if (box) {
			Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)?.set?.call(box, "my take");
			box.dispatchEvent(new Event("input", { bubbles: true }));
		}
	});
	await rightClick(q("li.message"));
	await choose("Quote reply");
	expect(draftOf(SCOUT)).toBe("my take\n\n> hello **bold**\n> second line\n\n");
});

test("with no message box on the page the quote waits in the room's draft", async () => {
	await page.render(<Message />);
	await rightClick(q("li.message"));
	await choose("Quote reply");
	expect(draftOf(SCOUT)).toBe("> hello **bold**\n> second line\n\n");
});

test("a message of a read-only room offers no quote", async () => {
	await page.render(<Message quotable={false} />);
	await rightClick(q("li.message"));
	expect(labels()).not.toContain("Quote reply");
});

test("on a phone Select text opens the message's text alone in a sheet, where nothing else can be selected and Copy all copies it", async () => {
	window.innerWidth = 390;
	const copied: string[] = [];
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText: async (text: string) => void copied.push(text) },
	});
	await page.render(
		<>
			<Message />
			<SelectTextSheetHost />
		</>,
	);
	await rightClick(q("li.message"));
	await choose("Select text");
	await page.act(async () => void (await settle(300)));
	const text = document.querySelector<HTMLElement>("pre.select-text");
	const sheet = text?.closest("dialog");
	expect(sheet?.open).toBe(true);
	// Exactly what was written, as stored: the Markdown marks and the line break too.
	expect(text?.textContent).toBe("hello **bold**\nsecond line");
	expect(sheet?.querySelector("[data-hold]")).toBeNull();
	expect(text?.closest("[data-hold]")).toBeNull();
	expect(window.getSelection()?.toString() ?? "").toBe("");
	await page.click(
		[...(sheet?.querySelectorAll("button") ?? [])].find(
			(one) => one.textContent === "Copy all",
		) ?? null,
	);
	await page.act(async () => void (await settle()));
	expect(copied).toEqual(["hello **bold**\nsecond line"]);
	await page.act(() => closeSelectText());
	await page.act(async () => void (await settle(300)));
	Reflect.deleteProperty(navigator, "clipboard");
});

test("Share hands the message's words to the system share sheet", async () => {
	const shared: unknown[] = [];
	Object.defineProperty(navigator, "share", {
		value: (data: unknown) => {
			shared.push(data);
			return Promise.resolve();
		},
		configurable: true,
	});
	await page.render(<Message />);
	await rightClick(q("li.message"));
	await choose("Share");
	expect(shared.length).toBe(1);
	expect((shared[0] as { text: string }).text).toContain("hello bold");
});

test("system lines have no menu", async () => {
	await page.render(
		<Message
			message={said({ kind: "system", text: "Conversation started over" })}
		/>,
	);
	await rightClick(q("li.line"));
	expect(labels()).toEqual([]);
});

test("a message's avatar opens the agent sheet; the message's own menu does not also open", async () => {
	await page.render(<Message />);
	await rightClick(q(".message-avatar"));
	expect(labels()).toEqual(["Knight profile"]);
	await choose("Knight profile");
	expect(currentAgentSheet()).toMatchObject({ name: "scout", look: false });
});

// ── Cards and files ──────────────────────────────────────────────────────────────────────────

const approval: PromptFrame = {
	id: "p1",
	kind: "approval",
	title: "Run the deploy?",
	message: "Deploy **web** to staging",
	purpose: "action",
	approval: {
		tool: "bash",
		action: "deploy staging",
		input: { command: "make deploy" },
		files: [{ path: "deploy.sh", bytes: 12 }],
	},
};

test("a card's menu copies its details: title, text, tool, action and input", async () => {
	const written = copied();
	await page.render(
		<ConfigContext.Provider value={config}>
			<PromptCard
				card={{ room: SCOUT, frame: approval, after: 0 }}
				timeZone="UTC"
			/>
			<ActionMenuHost />
		</ConfigContext.Provider>,
	);
	await rightClick(q("article.prompt"));
	expect(labels()).toEqual(["Copy details"]);
	await choose("Copy details");
	const text = written[0] ?? "";
	expect(text).toContain("Run the deploy?");
	expect(text).toContain("Deploy **web** to staging");
	expect(text).toContain("bash");
	expect(text).toContain("deploy staging");
	expect(text).toContain("make deploy");
	expect(text).toContain("deploy.sh");
});

const doc: RoomFile = {
	id: "f1",
	name: "report.pdf",
	type: "application/pdf",
	size: 120,
} as RoomFile;
const picture: RoomFile = {
	id: "f2",
	name: "chart.png",
	type: "image/png",
	size: 90,
} as RoomFile;

test("a file chip's menu downloads the file, and shares it when the browser can", async () => {
	const clicks: HTMLAnchorElement[] = [];
	const onClick = (event: Event) => {
		if (event.target instanceof HTMLAnchorElement && event.target.download)
			clicks.push(event.target);
	};
	document.addEventListener("click", onClick, true);
	try {
		await page.render(<Message message={said({ files: [doc, picture] })} />);
		// The attachments load on demand.
		await rightClick(await shown(".file-chip"));
		expect(labels()).toEqual(["Download"]);
		expect(q(".file-chip")?.getAttribute("data-hold")).toBe("row");
		await choose("Download");
		expect(clicks.length).toBe(1);
		expect(clicks[0]?.download).toBe("report.pdf");
		expect(clicks[0]?.getAttribute("href")).toBe("api/files/f1");

		const shared: unknown[] = [];
		Object.defineProperty(navigator, "share", {
			value: (data: unknown) => {
				shared.push(data);
				return Promise.resolve();
			},
			configurable: true,
		});
		await rightClick(q(".file-chip"));
		expect(labels()).toEqual(["Download", "Share"]);
		await choose("Share");
		expect(shared).toEqual([
			{ title: "report.pdf", url: new URL("api/files/f1", location.href).href },
		]);

		// A picture is a file too; the message's own menu is not what opens over it.
		await rightClick(await shown("img.file-image"));
		expect(labels()).toEqual(["Download", "Share"]);
	} finally {
		document.removeEventListener("click", onClick, true);
	}
});

/** An owner message of Ada's, sent while a turn ran. */
