import { expect, test } from "bun:test";
import type { LayoutView, PromptFrame, RoomMessage } from "../src/api-types.ts";
import {
	all,
	BUILD,
	F1,
	F2,
	foldersPage,
	HOME,
	headings,
	List,
	load,
	page,
	q,
	rowOf,
	SCOUT,
	show,
	stored,
	view,
	WORK,
} from "./folders-fixture.tsx";
import { store } from "./lib/app-store.ts";
import { ARRANGED_CSS } from "./lib/arranged-style.ts";
import { COLLAPSED_KEY, reloadCollapsed } from "./lib/folds.ts";

foldersPage();

test("with no pin and no folder the page is as it was: Home, Agents, Groups, no folder controls", async () => {
	await show(<List />);
	expect(headings()).toEqual(["Home", "Knights", "Groups"]);
	expect(all(".folder")).toEqual([]);
	// Normal mode: no menu button beside a row, no arrange bar.
	expect(all(".row-more")).toEqual([]);
	expect(q(".arrange-bar")).toBeNull();
});

/** A message the room said at `at`, as the server's frame brings it. */
const said = (room: string, id: number, at: string): RoomMessage => ({
	id,
	room,
	kind: "agent",
	agent: room.slice(room.indexOf(".") + 1),
	author: "x",
	text: "hi",
	files: [],
	at,
});
const names = () => all(".room-row strong").map((one) => one.textContent);
/** Rooms of their own, so what they said does not reach the other tests through the store. */
const LIVE = ["app:agent.alpha", "app:agent.beta", "app:group.gamma"];
const loadLive = (layout: Partial<LayoutView> = {}) =>
	store.dispatch({
		type: "rooms_loaded",
		rooms: [view(HOME, { home: true }), ...LIVE.map((key) => view(key))],
		pins: layout.pins ?? [],
		folders: layout.folders ?? [],
	});
const say = (room: string, id: number, at: string) =>
	page.act(() => {
		store.dispatch({ type: "message", room, message: said(room, id, at) });
	});

test("a message in a room lower in the plain list moves it up at once, with no reload", async () => {
	loadLive();
	await show(<List />);
	expect(names()).toEqual(["guide", "alpha", "beta", "gamma"]);
	await say("app:agent.beta", 1, "2026-10-30T10:00:00.000Z");
	// Agents and groups stay apart, each by latest activity.
	expect(names()).toEqual(["guide", "beta", "alpha", "gamma"]);
	await say("app:agent.alpha", 1, "2026-10-30T10:05:00.000Z");
	expect(names()).toEqual(["guide", "alpha", "beta", "gamma"]);
});

test("a message in a room lower in Ungrouped moves it up at once, with no reload", async () => {
	loadLive({ folders: [{ id: F1, name: "Work", rooms: [] }] });
	await show(<List />);
	expect(names()).toEqual(["guide", "alpha", "beta", "gamma"]);
	await say("app:group.gamma", 1, "2026-10-30T11:00:00.000Z");
	expect(names()).toEqual(["guide", "gamma", "alpha", "beta"]);
});

test("Home leads, then the pinned rooms, the folders in order, and the rest as Ungrouped", async () => {
	load({
		pins: [BUILD],
		folders: [WORK, { id: F2, name: "Play", rooms: [] }],
	});
	await show(<List />);
	expect(headings()).toEqual(["Home", "Pinned", "Work", "Play", "Ungrouped"]);
	const names = all(".room-row strong").map((one) => one.textContent);
	expect(names).toEqual(["guide", "build", "scout", "team"]);
	// An empty folder says so.
	expect(q(`[data-folder="${F2}"] .folder-empty`)?.textContent).toBe(
		"No rooms in this folder yet.",
	);
	// A deleted agent's key in the layout shows nothing.
	load({ pins: ["app:agent.deleted", BUILD] });
	await show(<List />);
	expect(all(".room-row strong").map((one) => one.textContent)).toEqual([
		"guide",
		"build",
		"scout",
		"team",
	]);
});

test("a folder's header folds it, keeps the fold on this device, and counts its rooms", async () => {
	load({ folders: [WORK] });
	await show(<List />);
	const toggle = q<HTMLButtonElement>(".folder-toggle");
	expect(toggle?.getAttribute("aria-expanded")).toBe("true");
	expect(toggle?.textContent).toContain("1 room");
	expect(q(".folder-body")?.hasAttribute("hidden")).toBe(false);
	expect(all(".folder-body .room-row").length).toBe(1);
	await page.click(toggle);
	expect(toggle?.getAttribute("aria-expanded")).toBe("false");
	expect(q(".folder-body")?.hasAttribute("hidden")).toBe(true);
	// happy-dom does not apply the cascade, so a hidden body must also hold no rows: a browser
	// would show them (an author `display` rule beats the `hidden` attribute).
	expect(all(".folder-body .room-row").length).toBe(0);
	expect(all(".folder-body *").length).toBe(0);
	expect(toggle?.getAttribute("aria-controls")).toBe(q(".folder-body")?.id);
	expect(JSON.parse(stored.get(COLLAPSED_KEY) ?? "[]")).toEqual([F1]);
	await page.click(toggle);
	expect(toggle?.getAttribute("aria-expanded")).toBe("true");
	expect(all(".folder-body .room-row").length).toBe(1);
	expect(JSON.parse(stored.get(COLLAPSED_KEY) ?? "[]")).toEqual([]);
});

test("the arranged styles hide a folded folder's body even though they set its display", () => {
	// `.folder-body { display: flex }` would beat the `hidden` attribute's own rule.
	expect(ARRANGED_CSS).toMatch(
		/\.folder-body\[hidden\]\s*\{[^}]*display:\s*none/,
	);
});

test("a folded folder shows a small stack of its rooms' pictures, and how many more; an open one shows none", async () => {
	const names = ["a", "b", "c", "d", "e", "f"];
	const keys = names.map((name) => `app:agent.${name}`);
	store.dispatch({
		type: "rooms_loaded",
		rooms: [view(HOME, { home: true }), ...keys.map((key) => view(key))],
		pins: [],
		folders: [{ id: F1, name: "Work", rooms: keys }],
	});
	await show(<List />);
	expect(all(".folder-stack")).toEqual([]);
	await page.click(q(".folder-toggle"));
	expect(all(".folder-stack .folder-stack-item").length).toBe(4);
	expect(q(".folder-stack-more")?.textContent).toBe("+2");
	// The stack is decoration: the count the button already says is what a reader hears.
	expect(q(".folder-stack")?.getAttribute("aria-hidden")).toBe("true");
	expect(q(".folder-toggle")?.contains(q(".folder-stack"))).toBe(true);
	await page.click(q(".folder-toggle"));
	expect(all(".folder-stack")).toEqual([]);
});

test("a folded folder with four rooms or fewer shows them all and no count", async () => {
	load({ folders: [WORK] });
	stored.set(COLLAPSED_KEY, JSON.stringify([F1]));
	reloadCollapsed();
	await show(<List />);
	expect(all(".folder-stack .folder-stack-item").length).toBe(1);
	expect(q(".folder-stack-more")).toBeNull();
});

test("an ordinary folder's header is a light label, not the boxed card, and its fold button keeps readable text on hover, press and focus", () => {
	const rule = (selector: string) =>
		ARRANGED_CSS.match(
			new RegExp(`${selector.replace(/[.:()]/g, "\\$&")}\\s*\\{([^}]*)\\}`),
		)?.[1] ?? "";
	// No border and no fill on the header itself: that card is for the archive.
	const head = rule(".folder-head");
	expect(head).not.toMatch(/border|background/);
	// The base rule `button:hover:not(:disabled)` (an accent fill) out-specifies a plain `.folder-toggle`,
	// so the states are named under the header and set the fill and the text together.
	const states = ARRANGED_CSS.match(
		/\.folder-head \.folder-toggle:hover:not\(:disabled\),\s*\.folder-head \.folder-toggle:active:not\(:disabled\),\s*\.folder-head \.folder-toggle:focus-visible\s*\{([^}]*)\}/,
	)?.[1];
	expect(states).toMatch(/background:/);
	expect(states).toMatch(/color: var\(--text\)/);
	expect(states).not.toMatch(/accent/);
	expect(rule(".folder-head .folder-toggle")).toMatch(
		/justify-content: flex-start/,
	);
});

test("a folded folder keeps the open room under its heading and folds the others away, while its stored fold stays", async () => {
	load({ folders: [{ id: F1, name: "Work", rooms: [SCOUT, BUILD] }] });
	stored.set(COLLAPSED_KEY, JSON.stringify([F1]));
	reloadCollapsed();
	await show(<List active={SCOUT} />);
	expect(q(".folder-toggle")?.getAttribute("aria-expanded")).toBe("false");
	expect(all(".folder-body .room-row").map((row) => row.textContent)).toEqual([
		rowOf("scout")?.textContent ?? "",
	]);
	expect(q(".folder-body")?.hasAttribute("hidden")).toBe(false);
	// The stack speaks for the one room that is hidden.
	expect(all(".folder-stack .folder-stack-item").length).toBe(1);
	expect(JSON.parse(stored.get(COLLAPSED_KEY) ?? "[]")).toEqual([F1]);
	await show(<List active={BUILD} />);
	expect(rowOf("build")).not.toBeNull();
	expect(rowOf("scout")).toBeNull();
	await show(<List />);
	expect(all(".folder-body .room-row")).toEqual([]);
	expect(q(".folder-body")?.hasAttribute("hidden")).toBe(true);
});

test("a folded folder keeps a room with a waiting card visible and shows the working dots of the rooms it hides", async () => {
	load({ folders: [{ id: F1, name: "Work", rooms: [SCOUT, BUILD] }] });
	stored.set(COLLAPSED_KEY, JSON.stringify([F1]));
	reloadCollapsed();
	const card: PromptFrame = {
		id: "p1",
		kind: "approval",
		title: "Run the deploy?",
		message: "Deploy",
		purpose: "action",
	};
	store.dispatch({ type: "prompt", room: SCOUT, prompt: card });
	store.dispatch({
		type: "activity",
		room: BUILD,
		typing: true,
		stoppable: true,
	});
	await show(<List />);
	// The room that needs the owner stays; the one that only works folds away behind a dots mark.
	expect(rowOf("scout")?.textContent).toContain("1 card waiting");
	expect(rowOf("build")).toBeNull();
	expect(q(".folder-head .typing")).not.toBeNull();
	expect(q(".folder-head")?.textContent).not.toContain("card waiting");
	// Open, the rooms say it themselves.
	await page.click(q(".folder-toggle"));
	expect(q(".folder-head .typing")).toBeNull();
	store.dispatch({ type: "prompt_closed", prompt: "p1", outcome: "approved" });
	store.dispatch({
		type: "activity",
		room: BUILD,
		typing: false,
		stoppable: false,
	});
});

test("a folder shows a bell-slash when all its rooms are muted and a fainter one when some are", async () => {
	load({ folders: [{ id: F1, name: "Work", rooms: [SCOUT, BUILD] }] });
	await show(<List />);
	expect(q(".folder-head .muted-mark")).toBeNull();
	store.dispatch({ type: "room_muted", room: SCOUT, muted: true });
	await show(<List />);
	const some = q(".folder-head .muted-mark");
	expect(some?.getAttribute("aria-label")).toBe("Some notifications are off");
	expect(some?.hasAttribute("data-partial")).toBe(true);
	store.dispatch({ type: "room_muted", room: BUILD, muted: true });
	await show(<List />);
	const every = q(".folder-head .muted-mark");
	expect(every?.getAttribute("aria-label")).toBe("Notifications are off");
	expect(every?.hasAttribute("data-partial")).toBe(false);
});
