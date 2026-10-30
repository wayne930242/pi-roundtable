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
	SessionView,
	SkillDocView,
	SkillView,
} from "../src/api-types.ts";
import { Toaster } from "./components/toaster.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { ApiFailure, api } from "./lib/api.ts";
import { ConfigContext } from "./lib/config.ts";
import { editApi } from "./lib/edit-api.ts";
import { SkillsPage } from "./pages/skills.tsx";

const config: ConfigView = {
	title: "Console",
	panes: ["skills"],
	timeZone: "UTC",
	look: "modern",
};

const AT = "2026-10-29T08:00:00.000Z";
const text = (body: string, name = "daily-notes") =>
	`---\nname: ${name}\ndescription: "Use when keeping notes."\n---\n\n${body}\n`;
const hash = (n: number) => String(n).padStart(64, "0");

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
const button = (label: string) =>
	all<HTMLButtonElement>("button").find(
		(one) => one.textContent?.trim() === label,
	) ?? null;
const typeInto = (element: HTMLTextAreaElement | null, value: string) => {
	if (!element) throw new Error("nothing to type into");
	return page.act(() => {
		Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)?.set?.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
};
const card = (name: string) =>
	all("article.card").find(
		(one) => one.querySelector("strong")?.textContent === name,
	);
const inCard = (name: string, label: string) =>
	[...(card(name)?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
		(one) => one.textContent?.trim() === label,
	) ?? null;

const CATALOG: SkillView[] = [
	{
		name: "writing-skills",
		source: { kind: "builtin" },
		description: "Use when writing a skill.",
		groups: [],
		carriers: [],
	},
	{
		name: "from-package",
		source: { kind: "package", package: "pi-anchorloop" },
		description: "Use when a package says so.",
		groups: [],
		carriers: [],
	},
	{
		name: "kit-do",
		source: { kind: "linked", repo: "acme/kit", path: "skills/kit-do" },
		description: "Use when changing source.",
		groups: [],
		carriers: [],
	},
	{
		name: "daily-notes",
		source: { kind: "written" },
		description: "Use when keeping notes.",
		groups: [],
		carriers: ["scout"],
	},
];

let current: SkillDocView;
let versions: {
	id: number;
	text: string;
	hash: string;
	by: string;
	at: string;
}[];
let skills: ReturnType<typeof spyOn>;
let session: ReturnType<typeof spyOn>;
let read: ReturnType<typeof spyOn>;
let save: ReturnType<typeof spyOn>;
let create: ReturnType<typeof spyOn>;
let history: ReturnType<typeof spyOn>;
let canEdit = true;

beforeEach(() => {
	canEdit = true;
	current = {
		name: "daily-notes",
		source: { kind: "written" },
		text: text("One."),
		hash: hash(1),
		writable: true,
	};
	versions = [
		{ id: 2, text: text("One."), hash: hash(1), by: "Sam", at: AT },
		{ id: 1, text: text("Zero."), hash: hash(0), by: "Riley", at: AT },
	];
	skills = spyOn(api, "skills").mockImplementation(async () =>
		CATALOG.map((entry) =>
			entry.name === "daily-notes" ? { ...entry } : entry,
		),
	);
	session = spyOn(api, "session").mockImplementation(
		async () =>
			({
				principal: { id: "1", name: "Riley" },
				surface: "app",
				auth: "verifier",
				...(canEdit ? { skillEdit: true as const } : {}),
			}) as SessionView,
	);
	read = spyOn(editApi, "skillDocument").mockImplementation(
		async () => current,
	);
	save = spyOn(editApi, "saveSkillDocument").mockImplementation(
		async (_name, { text: body }) => {
			current = {
				...current,
				text: body,
				hash: hash(current.text.length + body.length),
			};
			return current;
		},
	);
	create = spyOn(editApi, "createSkillDocument").mockImplementation(
		async ({ text: body }) => ({
			name: "fresh",
			source: { kind: "written" },
			text: body,
			hash: hash(9),
			writable: true,
		}),
	);
	history = spyOn(editApi, "skillHistory").mockImplementation(async () => ({
		versions,
	}));
});
afterEach(async () => {
	await page.render(null);
	for (const spy of [skills, session, read, save, create, history])
		spy.mockRestore();
});

async function show() {
	await page.render(
		<ConfigContext.Provider value={config}>
			<SkillsPage />
			<Toaster />
		</ConfigContext.Provider>,
	);
	await page.act(() => settle(80));
}

/** Opens the editor of a skill and waits for its chunk and its text. */
async function edit(name: string) {
	await page.click(inCard(name, "Edit"));
	for (let waited = 0; waited < 3000; waited += 40) {
		await page.act(() => settle(40));
		if (q("textarea.prompt-full") || q("dialog.sheet.full .failure")) return;
	}
}

test("a skill an agent wrote has an Edit button, and each other skill shows a lock and where it comes from", async () => {
	await show();
	expect(inCard("daily-notes", "Edit")).not.toBeNull();
	for (const name of ["writing-skills", "from-package", "kit-do"])
		expect(inCard(name, "Edit")).toBeNull();
	const reason = (name: string) =>
		card(name)?.querySelector(".skill-lock")?.textContent;
	expect(reason("writing-skills")).toContain("Built in with the release");
	expect(reason("from-package")).toContain("pi-anchorloop");
	expect(reason("kit-do")).toContain("acme/kit:skills/kit-do");
	expect(card("daily-notes")?.querySelector(".skill-lock")).toBeNull();
	expect(card("kit-do")?.querySelector(".skill-lock svg")).not.toBeNull();
	expect(button("New skill")).not.toBeNull();
	expect(q(".hint")?.textContent).toContain("can be edited here");
});

test("without the owner app nothing can be edited, and the page keeps its old hint", async () => {
	canEdit = false;
	await show();
	expect(inCard("daily-notes", "Edit")).toBeNull();
	expect(button("New skill")).toBeNull();
	expect(q(".hint")?.textContent).toContain("ask a knight on Discord");
});

test("editing opens the whole SKILL.md in a full-screen sheet; a change is read as a diff, then saved against the hash it was read with", async () => {
	await show();
	await edit("daily-notes");
	const dialog = q<HTMLDialogElement>("dialog.sheet.full");
	expect(dialog?.open).toBe(true);
	expect(dialog?.getAttribute("aria-label")).toBe("daily-notes");
	expect(read).toHaveBeenCalledWith("daily-notes");
	const area = q<HTMLTextAreaElement>("textarea.prompt-full");
	expect(area?.value).toBe(text("One."));
	expect(button("Review changes")?.disabled).toBe(true);
	await typeInto(area, text("Two."));
	await page.click(button("Review changes"));
	expect(save).not.toHaveBeenCalled();
	expect(
		all(".diff-line")
			.filter((one) => one.getAttribute("data-kind") !== "same")
			.map((one) => [
				one.getAttribute("data-kind"),
				one.textContent
					?.replace(/^[ +−]/, "")
					.replace(/^(Added|Removed): /, ""),
			]),
	).toEqual([
		["del", "One."],
		["add", "Two."],
	]);
	await page.click(button("Save"));
	expect(save).toHaveBeenCalledWith("daily-notes", {
		text: text("Two."),
		baseHash: hash(1),
	});
	expect(document.body.textContent).toContain("Saved.");
	// Saved: back to the editor with the saved text.
	expect(q(".review")).toBeNull();
	expect(q<HTMLTextAreaElement>("textarea.prompt-full")?.value).toBe(
		text("Two."),
	);
});

test("a save that lost to another is read again against what is there now, and saving again replaces it", async () => {
	await show();
	await edit("daily-notes");
	await typeInto(q<HTMLTextAreaElement>("textarea.prompt-full"), text("Mine."));
	await page.click(button("Review changes"));
	const theirs: SkillDocView = {
		...current,
		text: text("Theirs."),
		hash: hash(7),
	};
	save.mockRejectedValueOnce(
		new ApiFailure(
			"This skill changed while you were editing it.",
			undefined,
			409,
			{
				conflict: "changed",
				current: theirs,
			},
		),
	);
	await page.click(button("Save"));
	expect(q(".review .failure")?.textContent).toContain(
		"The changes below are against the version there now",
	);
	expect(
		all(".diff-line")
			.filter((one) => one.getAttribute("data-kind") === "del")
			.map((one) => one.textContent),
	).toEqual([expect.stringContaining("Theirs.")]);
	await page.click(button("Save"));
	expect(save).toHaveBeenLastCalledWith("daily-notes", {
		text: text("Mine."),
		baseHash: hash(7),
	});
	expect(q(".review")).toBeNull();
});

test("a refusal of the frontmatter is shown in the server's words and the draft stays", async () => {
	await show();
	await edit("daily-notes");
	await typeInto(
		q<HTMLTextAreaElement>("textarea.prompt-full"),
		"# no frontmatter",
	);
	await page.click(button("Review changes"));
	save.mockRejectedValueOnce(
		new ApiFailure(
			"A SKILL.md starts with frontmatter between two --- lines, holding name and description.",
			undefined,
			400,
		),
	);
	await page.click(button("Save"));
	expect(document.body.textContent).toContain("starts with frontmatter");
	expect(q(".review")).not.toBeNull();
});

test("History shows each saved version against the one before it, and a version goes into the editor to be reviewed", async () => {
	await show();
	await edit("daily-notes");
	await page.click(button("History"));
	for (let waited = 0; waited < 3000 && !q(".history .menu-item"); waited += 40)
		await page.act(() => settle(40));
	expect(history).toHaveBeenCalledWith("daily-notes");
	const rows = all(".history .menu-item").map((one) => one.textContent ?? "");
	expect(rows[0]).toContain("Sam");
	expect(rows[1]).toContain("Riley");
	await page.click(all<HTMLButtonElement>(".history .menu-item")[0] ?? null);
	// Sam's version against Riley's: the line he changed.
	expect(
		all(".history .diff-line")
			.filter((one) => one.getAttribute("data-kind") !== "same")
			.map((one) => [
				one.getAttribute("data-kind"),
				one.textContent
					?.replace(/^[ +−]/, "")
					.replace(/^(Added|Removed): /, ""),
			]),
	).toEqual([
		["del", "Zero."],
		["add", "One."],
	]);
	// The oldest version is read against nothing.
	await page.click(all<HTMLButtonElement>(".history .menu-item")[1] ?? null);
	expect(
		all(".history .diff-line").every(
			(one) =>
				one.getAttribute("data-kind") === "add" ||
				one.textContent?.trim() === "",
		),
	).toBe(true);
	await page.click(button("Use this text"));
	expect(q<HTMLTextAreaElement>("textarea.prompt-full")?.value).toBe(
		text("Zero."),
	);
	expect(save).not.toHaveBeenCalled();
	await page.click(button("Review changes"));
	expect(
		all(".diff-line").some((one) => one.getAttribute("data-kind") === "add"),
	).toBe(true);
});

test("a skill that is read-only is not editable even when opened, and says so", async () => {
	await show();
	current = {
		...current,
		writable: false,
		source: { kind: "linked", repo: "a/b", path: "c" },
	};
	await edit("daily-notes");
	expect(q("dialog.sheet.full .failure")?.textContent).toBe(
		"This skill cannot be edited here.",
	);
	expect(q("textarea.prompt-full")).toBeNull();
});

test("a skill that cannot be read shows why", async () => {
	await show();
	read.mockRejectedValue(new Error("the file is gone"));
	await edit("daily-notes");
	expect(q("dialog.sheet.full .failure")?.textContent).toBe("the file is gone");
});

test("New skill starts from a template, reads as an all-added diff, and creates the skill", async () => {
	await show();
	await page.click(button("New skill"));
	for (
		let waited = 0;
		waited < 3000 && !q("textarea.prompt-full");
		waited += 40
	)
		await page.act(() => settle(40));
	const dialog = q<HTMLDialogElement>("dialog.sheet.full");
	expect(dialog?.getAttribute("aria-label")).toBe("New skill");
	const area = q<HTMLTextAreaElement>("textarea.prompt-full");
	expect(area?.value).toContain("name: my-skill");
	expect(area?.value).toContain('description: "Use when ');
	// A new skill has no history to open.
	expect(button("History")).toBeNull();
	await typeInto(area, text("Fresh.", "fresh"));
	await page.click(button("Review changes"));
	expect(
		all(".diff-line")
			.filter((one) => one.textContent?.trim() !== "")
			.every((one) => one.getAttribute("data-kind") === "add"),
	).toBe(true);
	await page.click(button("Create skill"));
	await page.act(() => settle(80));
	expect(create).toHaveBeenCalledWith({ text: text("Fresh.", "fresh") });
	expect(document.body.textContent).toContain("Skill created.");
	// The sheet closes, and the list is read again.
	await page.act(() => settle(300));
	expect(q("dialog.sheet.full")?.hasAttribute("open")).toBeFalsy();
	expect(skills.mock.calls.length).toBeGreaterThan(1);
});

test("a taken name or a bad frontmatter keeps the new skill's draft open with the server's words", async () => {
	await show();
	await page.click(button("New skill"));
	for (
		let waited = 0;
		waited < 3000 && !q("textarea.prompt-full");
		waited += 40
	)
		await page.act(() => settle(40));
	await typeInto(
		q<HTMLTextAreaElement>("textarea.prompt-full"),
		text("Fresh.", "taken"),
	);
	await page.click(button("Review changes"));
	create.mockRejectedValueOnce(
		new ApiFailure('A skill named "taken" already exists.', undefined, 400),
	);
	await page.click(button("Create skill"));
	expect(document.body.textContent).toContain("already exists");
	expect(q(".review")).not.toBeNull();
});

test("saving an edit refreshes the list", async () => {
	await show();
	const before = skills.mock.calls.length;
	await edit("daily-notes");
	await typeInto(q<HTMLTextAreaElement>("textarea.prompt-full"), text("Two."));
	await page.click(button("Review changes"));
	await page.click(button("Save"));
	await page.act(() => settle(80));
	expect(skills.mock.calls.length).toBeGreaterThan(before);
});
