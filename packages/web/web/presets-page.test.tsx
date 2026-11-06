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
	PresetOverviewView,
	RoomView,
	SessionView,
} from "../src/api-types.ts";
import { Toaster } from "./components/toaster.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { editApi } from "./lib/edit-api.ts";
import { loadKit } from "./lib/kit.ts";
import { teamApi } from "./lib/team-api.ts";
import { MorePage } from "./pages/more.tsx";

const config: ConfigView = {
	title: "Console",
	panes: ["rooms", "presets"],
	timeZone: "UTC",
	look: "modern",
};
const room = (name: string): RoomView => ({
	key: `app:agent.${name}`,
	kind: "agent",
	name,
	displayName: name[0]?.toUpperCase() + name.slice(1),
	home: false,
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
});
const WRITER: PresetOverviewView = {
	agent: "scout",
	name: "writer",
	displayName: "Writer",
	prompt: "You write.",
	skills: ["kit-do"],
	sharedWith: "all",
	recruits: [
		{ knight: "scout", active: 1, archived: 2 },
		{ knight: "boss", active: 0, archived: 1 },
	],
};
const MEDIC: PresetOverviewView = {
	agent: "boss",
	name: "medic",
	displayName: "Medic",
	prompt: "You heal.",
	skills: [],
	recruits: [],
};
const SCRIBE: PresetOverviewView = {
	...MEDIC,
	agent: "scout",
	name: "scribe",
	displayName: "Scribe",
	sharedWith: ["boss"],
};

let page: TestPage;
let session: SessionView;
let presets: PresetOverviewView[];
const spies: { mockRestore(): void }[] = [];
const track = <T extends { mockRestore(): void }>(spy: T): T => {
	spies.push(spy);
	return spy;
};

beforeAll(async () => {
	await loadKit();
	page = await openPage();
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});
beforeEach(() => {
	session = {
		principal: { id: "owner", name: "Owner" },
		surface: "app",
		auth: "none",
		helpers: true,
	};
	presets = [MEDIC, SCRIBE, WRITER];
	store.dispatch({
		type: "rooms_loaded",
		rooms: [room("scout"), room("boss")],
	});
	track(spyOn(api, "session").mockImplementation(async () => session));
	track(spyOn(api, "models").mockResolvedValue({ models: ["model-a"] }));
	track(
		spyOn(teamApi, "allPresets").mockImplementation(async () => ({
			presets,
			max: 20,
		})),
	);
	track(
		spyOn(teamApi, "transferPreset").mockImplementation(async (_a, name) => {
			const moved = presets.find((p) => p.name === name) ?? WRITER;
			presets = presets.map((p) => (p === moved ? { ...p, agent: "boss" } : p));
			return { preset: moved };
		}),
	);
	track(spyOn(teamApi, "skills").mockResolvedValue({ skills: [] }));
	track(spyOn(editApi, "skillGroups").mockResolvedValue({ groups: [] }));
});
afterEach(async () => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	for (const dismiss of all('.toaster [aria-label="Dismiss"]'))
		await page.click(dismiss);
	await page.render(null);
	store.dispatch({ type: "rooms_loaded", rooms: [] });
});

const settle = (ms = 40) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
const q = <T extends Element = HTMLElement>(selector: string): T | null =>
	document.querySelector<T>(selector);
const all = <T extends Element = HTMLElement>(selector: string): T[] => [
	...document.querySelectorAll<T>(selector),
];
const button = (label: string) =>
	all<HTMLButtonElement>("button")
		.filter((one) => one.textContent?.trim() === label)
		.at(-1) ?? null;
const sheet = () => all<HTMLDialogElement>("dialog.sheet[open]").at(-1);
const owners = () =>
	all("[data-owner]").map((one) => one.getAttribute("data-owner"));
const rows = () =>
	all("[data-presets-page] [data-preset]").map((one) =>
		one.getAttribute("data-preset"),
	);
const change = (element: Element | null, value: string) =>
	page.act(() => {
		if (
			!(
				element instanceof HTMLInputElement ||
				element instanceof HTMLSelectElement
			)
		)
			throw new Error("nothing to change");
		const prototype = Object.getPrototypeOf(element);
		Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
			element,
			value,
		);
		element.dispatchEvent(
			new Event(element instanceof HTMLSelectElement ? "change" : "input", {
				bubbles: true,
			}),
		);
	});

async function open(): Promise<void> {
	const { default: PresetsPage } = await import("./pages/presets.tsx");
	await page.render(
		<ConfigContext.Provider value={config}>
			<PresetsPage />
			<Toaster />
		</ConfigContext.Provider>,
	);
	for (let waited = 0; waited < 3000; waited += 40) {
		await page.act(() => settle(40));
		if (q("[data-owner], .empty")) return;
	}
}

test("the presets are grouped by knight, each row with its skills, sharing and recruits", async () => {
	await open();
	expect(owners()).toEqual(["boss", "scout"]);
	expect(q("[data-owner=scout] .card-head")?.textContent).toBe("Scout");
	expect(q("[data-owner=scout] svg, [data-owner=scout] img")).not.toBeNull();
	expect(rows()).toEqual(["boss/medic", "scout/scribe", "scout/writer"]);
	const meta = (key: string) =>
		q(`[data-preset="${key}"] .meta`)?.textContent ?? "";
	expect(meta("scout/writer")).toBe(
		"Skills (1) · All knights · Recruited 4 times · 2 knights",
	);
	expect(meta("scout/scribe")).toBe(
		"Skills (0) · 1 knight · Recruited 0 times",
	);
	expect(meta("boss/medic")).toBe("Skills (0) · Only Boss · Recruited 0 times");
});

test("the search and the knight filter narrow the rows", async () => {
	await open();
	await change(q("[data-presets-page] input[type=search]"), "WRI");
	expect(rows()).toEqual(["scout/writer"]);
	// A knight's display name finds its presets too.
	await change(q("[data-presets-page] input[type=search]"), "boss");
	expect(rows()).toEqual(["boss/medic"]);
	await change(q("[data-presets-page] input[type=search]"), "");
	await change(q("[data-presets-page] select"), "scout");
	expect(owners()).toEqual(["scout"]);
	expect(rows()).toEqual(["scout/scribe", "scout/writer"]);
});

test("a row opens the preset sheet, with who recruited from it", async () => {
	await open();
	await page.click(q('[data-preset="scout/writer"]'));
	await page.act(() => settle(80));
	expect(sheet()?.getAttribute("aria-label")).toBe("Preset: writer");
	expect(sheet()?.querySelector(".preset-sheet")).not.toBeNull();
	const recruits = sheet()?.querySelector("[data-recruits]");
	expect(recruits?.textContent).toContain("Recruited 4 times · 2 knights");
	expect(
		[...(recruits?.querySelectorAll("[data-recruit]") ?? [])].map(
			(one) => one.textContent,
		),
	).toEqual(["ScoutActive 1 · Archived 2", "BossActive 0 · Archived 1"]);
	// The page gave the recruits; the sheet reads none of its own.
	expect(teamApi.allPresets).toHaveBeenCalledTimes(1);
});

test("a transfer asks for the knight, confirms, and the page reads the presets again", async () => {
	await open();
	await page.click(q('[data-preset="scout/writer"]'));
	await page.act(() => settle(80));
	await page.click(button("Transfer to…"));
	await page.act(() => settle(40));
	expect(sheet()?.getAttribute("aria-label")).toBe("Transfer preset");
	// Nothing picked is refused on the sheet.
	await page.click(button("Transfer preset"));
	await page.act(() => settle(40));
	expect(sheet()?.textContent).toContain("Choose a knight.");
	const picks = [
		...(sheet()?.querySelectorAll<HTMLInputElement>("input[type=checkbox]") ??
			[]),
	];
	expect(picks).toHaveLength(1);
	await page.click(picks[0] ?? null);
	await page.click(button("Transfer preset"));
	await page.act(() => settle(120));
	expect(teamApi.transferPreset).toHaveBeenCalledWith(
		"scout",
		"writer",
		"boss",
	);
	expect(document.body.textContent).toContain("Transferred to Boss.");
	expect(all("dialog.sheet[open]")).toHaveLength(0);
	expect(rows()).toEqual(["boss/medic", "boss/writer", "scout/scribe"]);
});

test("a new preset asks first which knight it belongs to, then opens the editor for it", async () => {
	await open();
	await page.click(button("New preset"));
	await page.act(() => settle(40));
	expect(sheet()?.getAttribute("aria-label")).toBe(
		"Which knight it belongs to",
	);
	const picks = [
		...(sheet()?.querySelectorAll<HTMLInputElement>("input[type=checkbox]") ??
			[]),
	];
	expect(picks).toHaveLength(2);
	await page.click(picks[1] ?? null);
	await page.click(button("Continue"));
	await page.act(() => settle(80));
	expect(sheet()?.getAttribute("aria-label")).toBe("New preset");
	expect(sheet()?.textContent).toContain("Only Boss");
});

test("with no presets, or temp knights off, the page says so", async () => {
	presets = [];
	await open();
	expect(q(".empty")?.textContent).toBe("No presets yet.");
	await page.render(null);
	session = { ...session, helpers: undefined };
	await open();
	expect(q(".empty")?.textContent).toBe("Temp knights are off on this host.");
	expect(button("New preset")).toBeNull();
});

test("the More page links to the presets with an icon", async () => {
	await page.render(
		<MorePage
			items={[
				{ pane: "skills", label: "Skills" },
				{ pane: "presets", label: "Presets" },
			]}
		/>,
	);
	const link = q<HTMLAnchorElement>('a[href="#/presets"]');
	expect(link?.textContent).toBe("Presets");
	expect(link?.querySelector(".menu-icon svg")).not.toBeNull();
});
