import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	spyOn,
	test,
} from "bun:test";
import type {
	ConfigView,
	PromptSummary,
	PromptView,
	SessionView,
} from "../src/api-types.ts";
import { Toaster } from "./components/toaster.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { ApiFailure, api } from "./lib/api.ts";
import { ConfigContext } from "./lib/config.ts";
import { editApi } from "./lib/edit-api.ts";
import { PromptsPage } from "./pages/prompts.tsx";
import { SettingsPage } from "./pages/settings.tsx";

const config: ConfigView = {
	title: "Console",
	panes: ["rooms"],
	timeZone: "UTC",
	look: "modern",
};

const AT = "2026-10-29T08:00:00.000Z";
const FILE = "Be kind.\nBe brief.";

let page: TestPage;
beforeAll(async () => {
	page = await openPage();
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});

const settle = (ms = 40) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
const q = <T extends Element = HTMLElement>(selector: string): T | null =>
	document.querySelector<T>(selector);
const all = <T extends Element = HTMLElement>(selector: string): T[] => [
	...document.querySelectorAll<T>(selector),
];
const button = (text: string) =>
	all<HTMLButtonElement>("button").find(
		(one) => one.textContent?.trim() === text,
	) ?? null;
const typeInto = (element: HTMLTextAreaElement | null, text: string) => {
	if (!element) throw new Error("nothing to type into");
	return page.act(() => {
		Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)?.set?.call(element, text);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
};

/** Documents as the server keeps them. */
let documents: Map<string, PromptView>;
const view = (over: Partial<PromptView> = {}): PromptView => ({
	id: "shared",
	label: "Shared prompt",
	description:
		"The base every agent's prompt starts with, the main assistant's included.",
	differs: false,
	text: FILE,
	fileText: FILE,
	maxChars: 20_000,
	...over,
});
const summary = (document: PromptView): PromptSummary => ({
	id: document.id,
	label: document.label,
	...(document.description ? { description: document.description } : {}),
	differs: document.differs,
	...(document.broken ? { broken: document.broken } : {}),
	...(document.override ? { override: document.override } : {}),
});

let list: ReturnType<typeof spyOn>;
let read: ReturnType<typeof spyOn>;
let save: ReturnType<typeof spyOn>;
let revert: ReturnType<typeof spyOn>;
let history: ReturnType<typeof spyOn>;

beforeEach(() => {
	documents = new Map([
		["shared", view()],
		[
			"guest",
			view({
				id: "guest",
				label: "Guest prompt",
				description: undefined,
				text: "Owner's guest text.",
				fileText: "Guest file text.",
				differs: true,
				override: { by: "Riley", at: AT },
			}),
		],
	]);
	list = spyOn(editApi, "prompts").mockImplementation(async () => ({
		documents: [...documents.values()].map(summary),
	}));
	read = spyOn(editApi, "prompt").mockImplementation(async (id) => {
		const found = documents.get(id);
		if (!found) throw new Error("no such prompt");
		return found;
	});
	save = spyOn(editApi, "savePrompt").mockImplementation(
		async (id, { text }) => {
			const found = documents.get(id) as PromptView;
			const next = {
				...found,
				text,
				differs: text !== found.fileText,
				override: { by: "Riley", at: AT },
			};
			documents.set(id, next);
			return next;
		},
	);
	revert = spyOn(editApi, "revertPrompt").mockImplementation(async (id) => {
		const found = documents.get(id) as PromptView;
		const { override: _override, ...rest } = found;
		const next = { ...rest, text: found.fileText, differs: false };
		documents.set(id, next);
		return next;
	});
	history = spyOn(editApi, "promptHistory").mockResolvedValue({
		versions: [
			{
				id: 3,
				action: "revert",
				text: "Guest file text.",
				previous: "Owner's guest text.",
				by: "Sam",
				at: AT,
			},
			{
				id: 2,
				action: "set",
				text: "Owner's guest text.",
				previous: "Guest file text.",
				by: "Riley",
				at: AT,
			},
		],
	});
});
afterEach(async () => {
	await page.render(null);
	for (const spy of [list, read, save, revert, history]) spy.mockRestore();
});

async function show() {
	await page.render(
		<ConfigContext.Provider value={config}>
			<PromptsPage />
			<Toaster />
		</ConfigContext.Provider>,
	);
	await page.act(() => settle(60));
}

async function openEditor(label: string) {
	const card = all("article.card").find((one) =>
		one.textContent?.includes(label),
	);
	await page.click(card?.querySelector<HTMLButtonElement>("button") ?? null);
	await page.act(() => settle(60));
}

test("lists the documents with a mark on the ones that differ from the file, and who set them", async () => {
	await show();
	const cards = all("article.card");
	expect(cards.map((one) => one.querySelector("strong")?.textContent)).toEqual([
		"Shared prompt",
		"Guest prompt",
	]);
	expect(cards[0]?.textContent).not.toContain("Differs from the file version");
	expect(cards[1]?.textContent).toContain("Differs from the file version");
	expect(cards[1]?.textContent).toContain("Set by Riley, ");
	expect(cards[0]?.textContent).toContain("The base every agent's prompt");
});

test("says so when a host has nothing to edit, and shows a failure to read the list", async () => {
	documents.clear();
	await show();
	expect(q(".empty")?.textContent).toBe("No prompts to edit.");
	await page.render(null);
	list.mockRejectedValue(new Error("the list is down"));
	await show();
	expect(q(".failure")?.textContent).toBe("the list is down");
});

test("the editor is a full-screen sheet with the text in force; saving needs a change and a look at the diff", async () => {
	await show();
	await openEditor("Shared prompt");
	const dialog = q<HTMLDialogElement>("dialog.sheet.full");
	expect(dialog?.open).toBe(true);
	expect(dialog?.getAttribute("aria-label")).toBe("Shared prompt");
	const area = q<HTMLTextAreaElement>("textarea.prompt-full");
	expect(area?.value).toBe(FILE);
	expect(button("Review changes")?.disabled).toBe(true);
	// No revert while the file version is in force.
	expect(button("Revert to the file version")).toBeNull();
	await typeInto(area, "Be kind.\nBe thorough.");
	expect(button("Review changes")?.disabled).toBe(false);
	await page.click(button("Review changes"));
	expect(save).not.toHaveBeenCalled();
	expect(
		all(".diff-line").map((one) => [
			one.getAttribute("data-kind"),
			one.textContent?.replace(/^[ +−]/, "").replace(/^(Added|Removed): /, ""),
		]),
	).toEqual([
		["same", "Be kind."],
		["del", "Be brief."],
		["add", "Be thorough."],
	]);
	// Back keeps the text; saving sends it with the text it was edited from.
	await page.click(button("Back to editing"));
	expect(q<HTMLTextAreaElement>("textarea.prompt-full")?.value).toBe(
		"Be kind.\nBe thorough.",
	);
	await page.click(button("Review changes"));
	await page.click(button("Save"));
	expect(save).toHaveBeenCalledWith("shared", {
		text: "Be kind.\nBe thorough.",
		base: FILE,
	});
	expect(document.body.textContent).toContain("Saved.");
	// Saved: the mark shows, and a revert is on offer.
	expect(q(".review")).toBeNull();
	expect(button("Revert to the file version")).not.toBeNull();
	expect(q("dialog.sheet.full")?.textContent).toContain(
		"Differs from the file version",
	);
});

test("an empty text cannot be reviewed", async () => {
	await show();
	await openEditor("Shared prompt");
	await typeInto(q<HTMLTextAreaElement>("textarea.prompt-full"), "  ");
	expect(button("Review changes")?.disabled).toBe(true);
});

test("a save that lost to another is read again against what is there now, and the draft is kept", async () => {
	await show();
	await openEditor("Shared prompt");
	await typeInto(q<HTMLTextAreaElement>("textarea.prompt-full"), "Mine.");
	await page.click(button("Review changes"));
	const theirs = view({
		text: "Theirs.",
		differs: true,
		override: { by: "Sam", at: AT },
	});
	save.mockRejectedValueOnce(
		new ApiFailure(
			"This prompt changed while you were editing it.",
			undefined,
			409,
			{ conflict: "changed", current: theirs },
		),
	);
	await page.click(button("Save"));
	expect(document.body.textContent).toContain(
		"This prompt changed while you were editing it.",
	);
	// Still reviewing, now against their text.
	expect(all(".diff-line").map((one) => one.getAttribute("data-kind"))).toEqual(
		["del", "add"],
	);
	expect(all(".diff-line")[0]?.textContent).toContain("Theirs.");
	await page.click(button("Save"));
	expect(save).toHaveBeenLastCalledWith("shared", {
		text: "Mine.",
		base: "Theirs.",
	});
});

test("another refusal is shown as it was worded, and the draft stays", async () => {
	await show();
	await openEditor("Shared prompt");
	await typeInto(q<HTMLTextAreaElement>("textarea.prompt-full"), "Mine.");
	await page.click(button("Review changes"));
	save.mockRejectedValueOnce(
		new ApiFailure(
			"A prompt document must have 1 to 20000 characters.",
			undefined,
			400,
		),
	);
	await page.click(button("Save"));
	expect(document.body.textContent).toContain("1 to 20000 characters");
	expect(q(".review")).not.toBeNull();
});

test("reverting asks first, names the document, and brings the file version back", async () => {
	await show();
	await openEditor("Guest prompt");
	expect(q<HTMLTextAreaElement>("textarea.prompt-full")?.value).toBe(
		"Owner's guest text.",
	);
	await page.click(button("Revert to the file version"));
	await page.act(() => settle(60));
	const confirm = all<HTMLDialogElement>("dialog.sheet").find(
		(one) =>
			one.getAttribute("aria-label") ===
			"Revert Guest prompt to the file version?",
	);
	expect(confirm?.open).toBe(true);
	expect(revert).not.toHaveBeenCalled();
	await page.click(
		[...(confirm?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
			(one) => one.textContent === "Revert to the file version",
		) ?? null,
	);
	await page.act(() => settle(60));
	expect(revert).toHaveBeenCalledWith("guest", { base: "Owner's guest text." });
	expect(q<HTMLTextAreaElement>("textarea.prompt-full")?.value).toBe(
		"Guest file text.",
	);
	expect(button("Revert to the file version")).toBeNull();
});

test("a revert that lost to another save shows what is there now and keeps the draft, with the way back still on offer", async () => {
	await show();
	await openEditor("Guest prompt");
	const theirs = view({
		id: "guest",
		label: "Guest prompt",
		text: "Sam's guest text.",
		fileText: "Guest file text.",
		differs: true,
		override: { by: "Sam", at: AT },
	});
	revert.mockRejectedValueOnce(
		new ApiFailure(
			"This prompt changed while you were editing it.",
			undefined,
			409,
			{ conflict: "changed", current: theirs },
		),
	);
	await page.click(button("Revert to the file version"));
	await page.act(() => settle(60));
	const confirm = all<HTMLDialogElement>("dialog.sheet").find(
		(one) =>
			one.getAttribute("aria-label") ===
			"Revert Guest prompt to the file version?",
	);
	await page.click(
		[...(confirm?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
			(one) => one.textContent === "Revert to the file version",
		) ?? null,
	);
	await page.act(() => settle(60));
	expect(revert).toHaveBeenCalledTimes(1);
	expect(document.body.textContent).toContain(
		"This prompt changed while you were editing it.",
	);
	// The draft is the text the owner had; the page now knows the text in force is Sam's.
	expect(q<HTMLTextAreaElement>("textarea.prompt-full")?.value).toBe(
		"Owner's guest text.",
	);
	expect(button("Review changes")?.disabled).toBe(false);
	expect(button("Revert to the file version")).not.toBeNull();
});

test("Cancel in the revert question leaves the text alone", async () => {
	await show();
	await openEditor("Guest prompt");
	await page.click(button("Revert to the file version"));
	await page.act(() => settle(60));
	await page.click(button("Cancel"));
	await page.act(() => settle(300));
	expect(revert).not.toHaveBeenCalled();
});

test("History marks a return to the file, and a version taken from it goes into the editor to be reviewed", async () => {
	await show();
	await openEditor("Guest prompt");
	await page.click(button("History"));
	for (let waited = 0; waited < 3000 && !q(".history .menu-item"); waited += 40)
		await page.act(() => settle(40));
	const rows = all(".history .menu-item").map((one) => one.textContent ?? "");
	expect(rows[0]).toContain("Sam");
	expect(rows[0]).toContain("Back to the file version");
	expect(rows[1]).toContain("Riley");
	await page.click(all<HTMLButtonElement>(".history .menu-item")[1] ?? null);
	await page.click(button("Use this text"));
	expect(q<HTMLTextAreaElement>("textarea.prompt-full")?.value).toBe(
		"Owner's guest text.",
	);
	// The text in force, so nothing differs yet.
	expect(button("Review changes")?.disabled).toBe(true);
	expect(save).not.toHaveBeenCalled();
});

test("a document whose file version cannot be read is marked in the list and shows why instead of an editor, and the others stay editable", async () => {
	documents.set(
		"merlin",
		view({
			id: "merlin",
			label: "Merlin's prompt",
			description: undefined,
			text: "",
			fileText: "",
			broken: "ENOENT: persona/merlin.md",
		}),
	);
	await show();
	expect(
		all("article.card").map((one) => one.querySelector("strong")?.textContent),
	).toEqual(["Shared prompt", "Guest prompt", "Merlin's prompt"]);
	expect(document.body.textContent).toContain("File version cannot be read");
	await openEditor("Merlin's prompt");
	expect(q("dialog.sheet.full .failure")?.textContent).toContain(
		"ENOENT: persona/merlin.md",
	);
	expect(q("textarea.prompt-full")).toBeNull();
	expect(button("Review changes")).toBeNull();
});

test("a document that cannot be read shows why instead of an editor", async () => {
	await show();
	read.mockRejectedValue(new Error("it is gone"));
	await openEditor("Shared prompt");
	expect(q("dialog.sheet.full .failure")?.textContent).toBe("it is gone");
	expect(q("textarea.prompt-full")).toBeNull();
});

test("Settings links to the main prompts only on a host that has them", async () => {
	const session = (over: Partial<SessionView>): SessionView => ({
		principal: { id: "1", name: "Riley" },
		surface: "app",
		auth: "verifier",
		...over,
	});
	const asked = spyOn(api, "session");
	try {
		for (const [reply, expected] of [
			[session({ prompts: true }), true],
			[session({}), false],
		] as const) {
			asked.mockResolvedValue(reply);
			await page.render(null);
			await page.render(
				<ConfigContext.Provider value={config}>
					<SettingsPage />
				</ConfigContext.Provider>,
			);
			await page.act(() => settle(80));
			const link = all<HTMLAnchorElement>("a.menu-link").find((one) =>
				one.textContent?.includes("Edit the main prompts"),
			);
			expect(link !== undefined).toBe(expected);
			if (link) expect(link.getAttribute("href")).toContain("prompts");
		}
	} finally {
		asked.mockRestore();
	}
});
