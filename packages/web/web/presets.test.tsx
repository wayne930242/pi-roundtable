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
	RoomView,
	SessionView,
	SharedPresetView,
} from "../src/api-types.ts";
import { AgentSheetHost } from "./components/agent-sheet.tsx";
import { Toaster } from "./components/toaster.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import {
	closeAgentSheet,
	currentAgentSheet,
	openAgentSheet,
	rememberAgentTab,
} from "./lib/agent-sheet.ts";
import { ApiFailure, api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { editApi } from "./lib/edit-api.ts";
import { loadKit } from "./lib/kit.ts";
import { teamApi } from "./lib/team-api.ts";
import { closeTeamSheet, currentTeamSheet } from "./lib/team-sheet.ts";

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

const MEDIC: SharedPresetView = {
	agent: "boss",
	name: "medic",
	displayName: "Medic",
	prompt: "You heal.",
	skills: [],
};
/** A knight in the room list, which the sharing's picker offers. */
const room = (name: string, over: Partial<RoomView> = {}): RoomView => ({
	key: `app:agent.${name}`,
	kind: "agent",
	name,
	displayName: name[0]?.toUpperCase() + name.slice(1),
	home: false,
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
	...over,
});

let page: TestPage;
let shared: SharedPresetView[];
let carried: boolean;
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
	shared = [];
	carried = false;
	saved = [];
	store.dispatch({
		type: "rooms_loaded",
		rooms: [
			room("scout"),
			room("boss"),
			room("boss-1", { helper: { parent: "app:agent.boss" } as never }),
		],
	});
	refuse = undefined;
	shown = profile();
	track(spyOn(api, "agent").mockImplementation(async () => shown));
	track(
		spyOn(api, "models").mockResolvedValue({ models: ["model-a", "model-b"] }),
	);
	track(spyOn(api, "session").mockImplementation(async () => session));
	track(
		spyOn(teamApi, "skills").mockImplementation(async () => ({
			skills: [
				{
					name: "writing-skills",
					source: "builtin",
					builtin: true,
					carried: true,
				},
				{ name: "kit-do", source: "linked", builtin: false, carried },
			],
		})),
	);
	track(spyOn(editApi, "skillGroups").mockResolvedValue({ groups: [] }));
	track(
		spyOn(teamApi, "presets").mockImplementation(async () => ({
			presets,
			shared,
			max: 20,
		})),
	);
	track(
		spyOn(teamApi, "savePreset").mockImplementation(
			async (_agent, name, body) => {
				if (refuse) throw new ApiFailure(refuse, undefined, 400, undefined);
				saved.push({ name, body });
				const { sharedWith, ...fields } = body;
				const preset = {
					name,
					...fields,
					skills: body.skills ?? [],
					...(sharedWith ? { sharedWith } : {}),
				};
				return { preset, replaced: presets.some((p) => p.name === name) };
			},
		),
	);
	track(spyOn(teamApi, "deletePreset").mockResolvedValue(undefined));
});
afterEach(async () => {
	closeAgentSheet();
	closeTeamSheet();
	rememberAgentTab("profile");
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
	// The presets are a tab of their own.
	await page.act(() => openAgentSheet("scout", card ? { tab: "presets" } : {}));
	for (let waited = 0; waited < 3000; waited += 40) {
		await page.act(() => settle(40));
		if (card ? q("[data-presets]") : q(".agent-sheet [aria-label=Skills]"))
			return;
	}
}

test("the knight's sheet lists its presets on their tab after the skills, with their count and the most it may keep", async () => {
	await open();
	const card = q("[data-presets]");
	expect(card?.querySelector("h3")?.textContent).toBe(
		"Temp knight presets (1/20)",
	);
	const row = card?.querySelector("[data-preset=writer]");
	expect(row?.textContent).toContain("writer · Writer");
	expect(row?.textContent).toContain("Skills (1) · You write the post.");
	expect(row?.textContent).not.toContain("Keep it short.");
	// Its tab comes after the skills'.
	expect(all(".agent-sheet [role=tab]").map((one) => one.textContent)).toEqual([
		"Basics",
		"Skills",
		"Presets",
		"Look",
		"More",
	]);
});

test("no card for a temp knight, nor where the host makes no temp knights", async () => {
	session = partialSession({});
	await open(false);
	await page.act(() => settle(120));
	expect(q("[data-presets]")).toBeNull();
	expect(all(".agent-sheet [role=tab]").map((one) => one.textContent)).toEqual([
		"Basics",
		"Skills",
		"Look",
		"More",
	]);
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
	expect(all(".agent-sheet [role=tab]").map((one) => one.textContent)).toEqual([
		"Basics",
		"Skills",
		"Look",
		"More",
	]);
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
	await page.click(sheet?.querySelector('button[aria-label="kit-do"]') ?? null);
	expect(teamApi.savePreset).not.toHaveBeenCalled();
	await page.click(ofEditor("Save"));
	await page.act(() => settle(60));
	expect(saved).toEqual([
		{
			name: "editor",
			body: {
				displayName: "Editor",
				prompt: "You edit.",
				skills: ["kit-do"],
				sharedWith: null,
			},
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
			sharedWith: null,
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

const chip = (label: string) =>
	[
		...(editor()?.querySelectorAll<HTMLButtonElement>(".option-chip") ?? []),
	].find((one) => one.textContent === label) ?? null;

test("the owner chooses whom a preset is available to: only its knight, every knight, or knights picked", async () => {
	await open();
	await page.click(q("[data-preset=writer]"));
	await page.act(() => settle(80));
	expect(editor()?.textContent).toContain("Available to");
	expect(chip("Only Scout")?.getAttribute("aria-pressed")).toBe("true");
	await page.click(chip("All knights"));
	await page.click(ofEditor("Save"));
	await page.act(() => settle(60));
	expect(saved.at(-1)?.body.sharedWith).toBe("all");
	await page.click(chip("Chosen knights"));
	// The picker offers the other knights, not this one nor a temp knight.
	const boxes = () =>
		[...(editor()?.querySelectorAll("input[type=checkbox]") ?? [])].map(
			(one) => one.closest("label")?.textContent,
		);
	expect(boxes()).toEqual(["Boss"]);
	await page.click(editor()?.querySelector("input[type=checkbox]") ?? null);
	await page.click(ofEditor("Save"));
	await page.act(() => settle(60));
	expect(saved.at(-1)?.body.sharedWith).toEqual(["boss"]);
});

test("a preset shared with the knight is listed read-only and opens in the knight that saved it", async () => {
	shared = [MEDIC];
	await open();
	const row = q("[data-shared-preset='boss/medic']");
	expect(row?.textContent).toContain("medic · Medic");
	expect(row?.textContent).toContain("Shared by Boss");
	// The count is of the knight's own presets.
	expect(q("[data-presets] h3")?.textContent).toBe(
		"Temp knight presets (1/20)",
	);
	await page.click(row);
	await page.act(() => settle(80));
	expect(editor()?.getAttribute("aria-label")).toBe("Preset: boss/medic");
	expect(editor()?.querySelector("fieldset")?.disabled).toBe(true);
	expect(ofEditor("Save")).toBeNull();
	expect(ofEditor("Delete preset")).toBeNull();
	expect(editor()?.textContent).not.toContain("Available to");
	await page.click(ofEditor("Open in Boss"));
	await page.act(() => settle(40));
	expect(currentAgentSheet()?.name).toBe("boss");
});

test("save as preset copies the knight into a new preset, with the skills it carries but the built-in ones", async () => {
	carried = true;
	await open();
	await page.click(button("Save as preset"));
	await page.act(() => settle(80));
	const sheet = editor();
	expect(sheet?.getAttribute("aria-label")).toBe("New preset");
	const inputs = sheet?.querySelectorAll<HTMLInputElement>("input") ?? [];
	expect(inputs[0]?.value).toBe("");
	expect(inputs[1]?.value).toBe("Scout");
	expect(sheet?.querySelector("textarea")?.value).toBe("You scout.");
	await typeInto(inputs[0], "scout-copy");
	await page.click(ofEditor("Save"));
	await page.act(() => settle(60));
	const { v: _v, ...look } = character;
	expect(saved).toEqual([
		{
			name: "scout-copy",
			body: {
				displayName: "Scout",
				prompt: "You scout.",
				skills: ["kit-do"],
				character: look,
				sharedWith: null,
			},
		},
	]);
});

test("a knight made from a preset opens the new knight's form with a copy of its fields", async () => {
	await open();
	await page.click(q("[data-preset=writer]"));
	await page.act(() => settle(80));
	await page.click(ofEditor("Create a knight from this"));
	await page.act(() => settle(40));
	expect(currentAgentSheet()).toBeUndefined();
	expect(currentTeamSheet()).toMatchObject({
		kind: "new-agent",
		from: {
			displayName: "Writer",
			prompt: WRITER.prompt,
			skills: ["kit-do"],
			model: "model-b",
		},
	});
});
