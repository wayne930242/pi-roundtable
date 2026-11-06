import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	spyOn,
	test,
} from "bun:test";
import { CATALOG, type CharacterSpec } from "pi-roundtable/characters";
import type {
	AgentProfileView,
	ConfigView,
	PresetSave,
	PresetView,
	SessionView,
} from "../src/api-types.ts";
import { AgentSheetHost } from "./components/agent-sheet.tsx";
import { Toaster } from "./components/toaster.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { closeAgentSheet, openAgentSheet } from "./lib/agent-sheet.ts";
import { ApiFailure, api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { editApi } from "./lib/edit-api.ts";
import { loadKit } from "./lib/kit.ts";
import { teamApi } from "./lib/team-api.ts";

const config: ConfigView = {
	title: "Console",
	panes: ["rooms"],
	timeZone: "UTC",
	look: "modern",
};
const character: CharacterSpec = {
	v: 1,
	class: "knight",
	...CATALOG.classes.knight.preset,
};
const profile = (over: Partial<AgentProfileView> = {}): AgentProfileView => ({
	name: "scout",
	displayName: "Scout",
	prompt: "You scout.",
	effective: { model: "model-a", thinking: "medium" },
	avatar: "avatars/x.png",
	character,
	room: "app:agent.scout",
	...over,
});
const WRITER: PresetView = {
	name: "writer",
	displayName: "Writer",
	prompt: "You write the post.\nKeep it short.",
	skills: ["kit-do"],
	model: "model-b",
};

let page: TestPage;
let session: SessionView;
let shown: AgentProfileView;
let presets: PresetView[];
let saved: { name: string; body: PresetSave }[];
let refuse: string | undefined;
const spies: { mockRestore(): void }[] = [];
const track = <T extends { mockRestore(): void }>(spy: T): T => {
	spies.push(spy);
	return spy;
};

beforeAll(async () => {
	await loadKit();
	await import("./components/preset-sheet.tsx");
	await import("./components/character-creator.tsx");
	page = await openPage();
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});
beforeEach(() => {
	window.innerWidth = 1280;
	session = partialSession({ helpers: true });
	presets = [WRITER];
	saved = [];
	refuse = undefined;
	shown = profile();
	track(spyOn(api, "agent").mockImplementation(async () => shown));
	track(
		spyOn(api, "models").mockResolvedValue({ models: ["model-a", "model-b"] }),
	);
	track(spyOn(api, "session").mockImplementation(async () => session));
	track(
		spyOn(teamApi, "skills").mockResolvedValue({
			skills: [
				{
					name: "writing-skills",
					source: "builtin",
					builtin: true,
					carried: true,
				},
				{ name: "kit-do", source: "linked", builtin: false, carried: false },
			],
		}),
	);
	track(spyOn(editApi, "skillGroups").mockResolvedValue({ groups: [] }));
	track(
		spyOn(teamApi, "presets").mockImplementation(async () => ({
			presets,
			max: 20,
		})),
	);
	track(
		spyOn(teamApi, "savePreset").mockImplementation(
			async (_agent, name, body) => {
				if (refuse) throw new ApiFailure(refuse, undefined, 400, undefined);
				saved.push({ name, body });
				const preset = { name, ...body, skills: body.skills ?? [] };
				return { preset, replaced: presets.some((p) => p.name === name) };
			},
		),
	);
	track(spyOn(teamApi, "deletePreset").mockResolvedValue(undefined));
});
afterEach(async () => {
	closeAgentSheet();
	for (const spy of spies.splice(0)) spy.mockRestore();
	for (const dismiss of all('.toaster [aria-label="Dismiss"]'))
		await page.click(dismiss);
	await page.render(null);
	store.dispatch({ type: "rooms_loaded", rooms: [] });
});

function partialSession(over: Partial<SessionView>): SessionView {
	return {
		principal: { id: "owner", name: "Owner" },
		surface: "app",
		auth: "none",
		...over,
	};
}

const settle = (ms = 40) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
const q = <T extends Element = HTMLElement>(selector: string): T | null =>
	document.querySelector<T>(selector);
const all = <T extends Element = HTMLElement>(selector: string): T[] => [
	...document.querySelectorAll<T>(selector),
];
const text = () => document.body.textContent ?? "";
const button = (label: string) =>
	all<HTMLButtonElement>("button")
		.filter((one) => one.textContent?.trim() === label)
		.at(-1) ?? null;
/** The open preset editor: the last wide sheet over the knight's. */
const editor = () => all<HTMLDialogElement>("dialog.sheet[open]").at(-1);
/** A button of the open editor's own form, not of the knight's sheet around it. */
const ofEditor = (label: string) =>
	[
		...(editor()?.querySelectorAll<HTMLButtonElement>("form button") ?? []),
	].find((one) => one.textContent?.trim() === label) ?? null;
const typeInto = (element: Element | null | undefined, value: string) =>
	page.act(() => {
		if (
			!(
				element instanceof HTMLInputElement ||
				element instanceof HTMLTextAreaElement
			)
		)
			throw new Error("nothing to type into");
		const prototype = Object.getPrototypeOf(element);
		Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
			element,
			value,
		);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});

async function open(card = true): Promise<void> {
	await page.render(
		<ConfigContext.Provider value={config}>
			<AgentSheetHost />
			<Toaster />
		</ConfigContext.Provider>,
	);
	await page.act(() => openAgentSheet("scout", { look: false, skills: false }));
	for (let waited = 0; waited < 3000; waited += 40) {
		await page.act(() => settle(40));
		if (card ? q("[data-presets]") : q(".agent-sheet [aria-label=Skills]"))
			return;
	}
}

test("the knight's sheet lists its presets under the skills, with their count and the most it may keep", async () => {
	await open();
	const card = q("[data-presets]");
	expect(card?.querySelector("h3")?.textContent).toBe(
		"Temp knight presets (1/20)",
	);
	const row = card?.querySelector("[data-preset=writer]");
	expect(row?.textContent).toContain("writer · Writer");
	expect(row?.textContent).toContain("Skills (1) · You write the post.");
	expect(row?.textContent).not.toContain("Keep it short.");
	// It comes after the skills card.
	const cards = all(".agent-sheet > section.card");
	expect(cards.findIndex((one) => one.hasAttribute("data-presets"))).toBe(
		cards.findIndex((one) => one.getAttribute("aria-label") === "Skills") + 1,
	);
});

test("no card for a temp knight, nor where the host makes no temp knights", async () => {
	session = partialSession({});
	await open(false);
	await page.act(() => settle(120));
	expect(q("[data-presets]")).toBeNull();
	closeAgentSheet();
	await page.render(null);
	session = partialSession({ helpers: true });
	shown = profile({
		helper: { parent: "app:agent.boss", parentName: "Boss" },
	});
	await open(false);
	await page.act(() => settle(120));
	expect(q(".agent-sheet")).not.toBeNull();
	expect(q("[data-presets]")).toBeNull();
	expect(teamApi.presets).not.toHaveBeenCalled();
});

test("a new preset is made in a sheet over the knight's, with the shared fields, skills and look", async () => {
	await open();
	await page.click(button("New preset"));
	await page.act(() => settle(80));
	const sheet = editor();
	expect(sheet?.getAttribute("aria-label")).toBe("New preset");
	// The same fields as a knight's: the model select's first row is the knight's own.
	expect(sheet?.querySelector("select option")?.textContent).toBe(
		"The knight's own",
	);
	expect(sheet?.querySelector(".option-chip")?.textContent).toBe(
		"The knight's own",
	);
	expect(sheet?.textContent).toContain("Suggested from its role");
	expect(ofEditor("Save")?.disabled).toBe(true);
	await typeInto(sheet?.querySelector("input"), "editor");
	const inputs = sheet?.querySelectorAll("input") ?? [];
	await typeInto(inputs[1], "Editor");
	await typeInto(sheet?.querySelector("textarea"), "You edit.");
	// A skill's switch changes the draft only; nothing is sent yet.
	await page.click(
		sheet?.querySelector('[role="switch"][aria-label="kit-do"]') ?? null,
	);
	expect(teamApi.savePreset).not.toHaveBeenCalled();
	await page.click(ofEditor("Save"));
	await page.act(() => settle(60));
	expect(saved).toEqual([
		{
			name: "editor",
			body: { displayName: "Editor", prompt: "You edit.", skills: ["kit-do"] },
		},
	]);
	expect(text()).toContain("Created the preset.");
	expect(q("[data-presets] h3")?.textContent).toBe(
		"Temp knight presets (2/20)",
	);
});

test("an existing preset opens with its name fixed, saves whole, and a refusal shows in the sheet", async () => {
	await open();
	await page.click(q("[data-preset=writer]"));
	await page.act(() => settle(80));
	const sheet = editor();
	expect(sheet?.getAttribute("aria-label")).toBe("Preset: writer");
	const name = sheet?.querySelector<HTMLInputElement>("input");
	expect(name?.value).toBe("writer");
	expect(name?.readOnly).toBe(true);
	expect(sheet?.querySelector<HTMLSelectElement>("select")?.value).toBe(
		"model-b",
	);
	refuse = "Unknown skills: kit-do.";
	await typeInto(sheet?.querySelector("textarea"), "You write the long post.");
	await page.click(ofEditor("Save"));
	await page.act(() => settle(60));
	expect(sheet?.querySelector(".failure")?.textContent).toContain(
		"Unknown skills: kit-do.",
	);
	expect(editor()).toBe(sheet);
	refuse = undefined;
	await page.click(ofEditor("Save"));
	await page.act(() => settle(60));
	expect(saved.at(-1)).toEqual({
		name: "writer",
		body: {
			displayName: "Writer",
			prompt: "You write the long post.",
			skills: ["kit-do"],
			model: "model-b",
		},
	});
	expect(text()).toContain("Saved the preset.");
});

test("deleting a preset asks first, then takes its row away", async () => {
	await open();
	await page.click(q("[data-preset=writer]"));
	await page.act(() => settle(80));
	await page.click(ofEditor("Delete preset"));
	await page.act(() => settle(40));
	expect(editor()?.getAttribute("aria-label")).toBe("Delete writer?");
	expect(teamApi.deletePreset).not.toHaveBeenCalled();
	await page.click(button("Delete preset"));
	await page.act(() => settle(80));
	expect(teamApi.deletePreset).toHaveBeenCalledWith("scout", "writer");
	expect(text()).toContain("Deleted the preset.");
	expect(q("[data-preset=writer]")).toBeNull();
	expect(q("[data-presets] h3")?.textContent).toBe(
		"Temp knight presets (0/20)",
	);
	// The confirmation and the editor are both closed.
	expect(all("dialog.sheet[open]")).toHaveLength(1);
});
