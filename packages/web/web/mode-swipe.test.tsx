import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	spyOn,
	test,
} from "bun:test";
import type { ConfigView, RoomMode, RoomView } from "../src/api-types.ts";
import { ZH_TW } from "../src/i18n/zh-tw.ts";
import { ActionMenuHost } from "./components/action-menu.tsx";
import { RoomConfirmHost } from "./components/room-confirms.tsx";
import { RoomSwitcher, useSwitcher } from "./components/switcher.tsx";
import { Toaster } from "./components/toaster.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { closeMenu } from "./lib/action-menu.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { bulkApi } from "./lib/bulk-api.ts";
import { ConfigContext } from "./lib/config.ts";
import { reloadCollapsed } from "./lib/folds.ts";
import { seedUnread, unreadCounts } from "./lib/host-state.ts";
import { loadKit } from "./lib/kit.ts";
import { HOLD_MS } from "./lib/long-press.ts";
import { roomMenu } from "./lib/menu-items.ts";
import { clearRoomConfirm } from "./lib/room-confirm.ts";
import { setRouting } from "./lib/router.ts";
import { RoomsPage } from "./pages/rooms.tsx";

// Rooms of this file's own: the store is shared by the files of a run.
const HOME = "app:agent.rs-guide";
const SCOUT = "app:agent.rs-scout";
const BUILD = "app:agent.rs-build";
const DONE = "app:thread.0b5e7c1a-0000-4000-8000-0000000000a1";
const TEMP = "app:agent.rs-temp";
const LONG = "app:agent.rs-long";
const SEALED = "app:agent.rs-sealed";
const FOLDER = "folder.00000000-0000-4000-8000-0000000000a1";

const config: ConfigView = {
	title: "Console",
	panes: ["rooms"],
	timeZone: "UTC",
	look: "modern",
};

const short = (key: string) =>
	key.slice(key.indexOf(".") + 1).replace(/^rs-/, "");
const view = (key: string, over: Partial<RoomView> = {}): RoomView => ({
	key,
	kind: "agent",
	name: short(key),
	displayName: short(key),
	home: false,
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
	...over,
});

const ROOMS = [
	view(HOME, { home: true }),
	view(SCOUT),
	view(BUILD),
	view(LONG, { mode: { yolo: false, longRunning: true } }),
	view(SEALED, { readOnly: true }),
	view(DONE, {
		kind: "thread",
		name: DONE.slice(DONE.indexOf(":") + 1),
		displayName: "Fix the build",
		parent: SCOUT,
		readOnly: true,
		closed: true,
	}),
	view(TEMP, {
		helper: { parent: BUILD, parentName: "build", finished: true },
	}),
];

let page: TestPage;
let reduced = true;
const realMatchMedia = globalThis.matchMedia;
const stored = new Map<string, string>();
const spies: { mockRestore(): void }[] = [];
const track = <T extends { mockRestore(): void }>(spy: T): T => {
	spies.push(spy);
	return spy;
};
const clearUnread = () =>
	seedUnread(
		Object.fromEntries(Object.keys(unreadCounts()).map((k) => [k, 0])),
	);

beforeAll(async () => {
	await loadKit();
	// The gesture and its action load after the list; loading them now keeps that out of the first test.
	await import("./lib/read-swipe.ts");
	await import("./lib/mode-swipe.ts");
	await import("./lib/drag.ts");
	page = await openPage();
	setRouting(undefined);
	Object.defineProperty(globalThis, "localStorage", {
		value: {
			getItem: (key: string) => stored.get(key) ?? null,
			setItem: (key: string, value: string) => void stored.set(key, value),
			removeItem: (key: string) => void stored.delete(key),
		},
		configurable: true,
	});
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});
beforeEach(() => {
	window.innerWidth = 390;
	reduced = true;
	stored.clear();
	reloadCollapsed();
	clearUnread();
	Object.defineProperty(globalThis, "matchMedia", {
		value: (query: string) => ({
			matches: reduced && query.includes("reduce"),
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
		}),
		configurable: true,
	});
});
afterEach(async () => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	await page.act(() => closeMenu());
	// The menu's yolo question is the page's, not the test's: left open, it would hold the next file's sheets.
	await page.act(() => clearRoomConfirm());
	for (const dismiss of document.querySelectorAll<HTMLElement>(
		'.toaster [aria-label="Dismiss"]',
	))
		await page.click(dismiss);
	await page.render(null);
	store.dispatch({ type: "rooms_loaded", rooms: [], pins: [], folders: [] });
	clearUnread();
	Object.defineProperty(globalThis, "matchMedia", {
		value: realMatchMedia,
		configurable: true,
	});
});

const settle = (ms = 40) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

async function show(
	unread: Record<string, number> = { [SCOUT]: 3 },
	folders: { id: string; name: string; rooms: string[] }[] = [],
) {
	await page.render(
		<ConfigContext.Provider value={config}>
			<RoomsPage onSearch={() => undefined} />
			<ActionMenuHost />
			<RoomConfirmHost />
			<Toaster />
		</ConfigContext.Provider>,
	);
	await page.act(() =>
		store.dispatch({ type: "rooms_loaded", rooms: ROOMS, pins: [], folders }),
	);
	seedUnread(unread);
	// The gestures load after the list.
	for (
		let i = 0;
		i < 160 &&
		(document.querySelectorAll("[data-folder-block]").length < folders.length ||
			document.querySelector(".thread-card") === null);
		i += 1
	)
		await page.act(() => settle(25));
	await page.act(() => settle(80));
}

/** A room's row; a real one has a width, and happy-dom lays nothing out. */
const rowOf = (key: string, selector = "a.room-row"): HTMLElement => {
	const found = document.querySelector<HTMLElement>(
		`${selector}[data-room="${key}"]`,
	);
	if (!found) throw new Error(`no row ${key}`);
	Object.defineProperty(found, "offsetWidth", {
		value: 300,
		configurable: true,
	});
	return found;
};
const revealOf = (row: HTMLElement, kind = "mode") =>
	row.parentElement?.querySelector<HTMLElement>(`:scope > .${kind}-reveal`);

function touch(
	target: Element,
	type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
	x: number,
	y: number,
): void {
	target.dispatchEvent(
		new PointerEvent(type, {
			bubbles: true,
			cancelable: true,
			clientX: x,
			clientY: y,
			pointerId: 9,
			pointerType: "touch",
			isPrimary: true,
		}),
	);
}

/** A finger from (start, 100) to (end, 100 + sag), in steps, still down. */
async function drag(target: Element, start: number, end: number, sag = 2) {
	await page.act(() => touch(target, "pointerdown", start, 100));
	const steps = 6;
	for (let i = 1; i <= steps; i += 1)
		await page.act(() =>
			touch(
				target,
				"pointermove",
				start + ((end - start) * i) / steps,
				100 + (sag * i) / steps,
			),
		);
}
/** Lets go at x; `rest` is how long the finger stayed still first, since a quick lift is a flick. */
const lift = (target: Element, x: number, rest = 0) =>
	page.act(async () => {
		if (rest) await settle(rest);
		touch(target, "pointerup", x, 102);
		await settle();
	});

const menuItems = (): HTMLElement[] => [
	...document.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
];
const labels = () => menuItems().map((one) => one.textContent);
const notice = () => document.querySelector(".toaster")?.textContent ?? "";
const modeOf = (key: string) => {
	const mode = store.getState().rooms[key]?.mode;
	return { yolo: mode?.yolo, longRunning: mode?.longRunning };
};
const confirmShown = () =>
	(document.body.textContent ?? "").includes("Turn on yolo mode?");
const setMode = () =>
	track(spyOn(api, "setMode")).mockImplementation(
		async (_room: string, change: Partial<RoomMode>) => ({
			mode: { yolo: false, longRunning: false, ...change },
		}),
	);
/** A left swipe past the threshold, let go. */
async function swipeLeft(row: HTMLElement) {
	await drag(row, 300, 100);
	await lift(row, 100);
}
const readAll = () =>
	track(spyOn(bulkApi, "readAll")).mockResolvedValue({
		moved: [{ room: SCOUT, from: 4, to: 7 }],
	});

test("a row swiped left past the threshold turns none to yolo, yolo to yolo and long-running, and both to none", async () => {
	const send = setMode();
	await show({});
	const row = rowOf(SCOUT);
	await drag(row, 300, 100);
	expect(row.style.transform).toContain("translate3d(-");
	expect(row.hasAttribute("data-armed")).toBe(true);
	const reveal = revealOf(row);
	expect(reveal?.hasAttribute("data-shown")).toBe(true);
	expect(reveal?.hasAttribute("data-armed")).toBe(true);
	expect(reveal?.getAttribute("aria-hidden")).toBe("true");
	expect(reveal?.dataset.to).toBe("yolo");
	expect(revealOf(row, "read")?.hasAttribute("data-shown")).toBe(false);
	await lift(row, 100);
	expect(row.style.transform).toBe("");
	expect(send.mock.calls.at(-1)).toEqual([
		SCOUT,
		{ yolo: true, longRunning: false },
	]);
	expect(modeOf(SCOUT)).toEqual({ yolo: true, longRunning: false });
	expect(row.querySelector(".badge-yolo")).not.toBeNull();
	await drag(row, 300, 100);
	expect(revealOf(row)?.dataset.to).toBe("both");
	expect(revealOf(row)?.querySelectorAll("svg").length).toBe(2);
	await lift(row, 100);
	expect(modeOf(SCOUT)).toEqual({ yolo: true, longRunning: true });
	expect(row.querySelector(".badge-long")).not.toBeNull();
	await drag(row, 300, 100);
	expect(revealOf(row)?.dataset.to).toBe("off");
	expect(revealOf(row)?.textContent).toBe("Off");
	await lift(row, 100);
	expect(modeOf(SCOUT)).toEqual({ yolo: false, longRunning: false });
	expect(row.querySelector(".badge-yolo, .badge-long")).toBeNull();
	expect(send).toHaveBeenCalledTimes(3);
	expect(notice()).toContain("scout: modes off");
	// The click the lift brings does not open the room.
	window.location.hash = "#/rooms";
	await page.click(row);
	expect(window.location.hash).toBe("#/rooms");
});

test("a room with only long-running on turns to none", async () => {
	const send = setMode();
	await show({});
	const row = rowOf(LONG);
	await drag(row, 300, 100);
	expect(revealOf(row)?.dataset.to).toBe("off");
	await lift(row, 100);
	expect(send.mock.calls[0]).toEqual([
		LONG,
		{ yolo: false, longRunning: false },
	]);
	expect(modeOf(LONG)).toEqual({ yolo: false, longRunning: false });
});

test("yolo by swipe asks nothing and shows one notice whose Undo puts the modes back", async () => {
	const send = setMode();
	await show({});
	const row = rowOf(SCOUT);
	await swipeLeft(row);
	expect(confirmShown()).toBe(false);
	expect(
		document.querySelectorAll('.toaster [aria-label="Dismiss"]').length,
	).toBe(1);
	expect(notice()).toContain("scout: Yolo on");
	const undo = [
		...document.querySelectorAll<HTMLElement>(".toaster button"),
	].find((one) => one.textContent === "Undo");
	if (!undo) throw new Error("no undo");
	await page.click(undo);
	await page.act(() => settle());
	expect(send.mock.calls.at(-1)).toEqual([
		SCOUT,
		{ yolo: false, longRunning: false },
	]);
	expect(modeOf(SCOUT)).toEqual({ yolo: false, longRunning: false });
	expect(ZH_TW["{name}: Yolo on"]).toBeDefined();
	expect(ZH_TW["{name}: Yolo and long-running on"]).toBeDefined();
	expect(ZH_TW["{name}: modes off"]).toBeDefined();
});

test("the menu still asks before yolo goes on", async () => {
	setMode();
	await show({});
	await page.act(() => {
		roomMenu(SCOUT)
			?.items.find((one) => one.id === "yolo")
			?.run?.();
	});
	await page.act(() => settle());
	expect(confirmShown()).toBe(true);
});

test("a short pull and a swipe from the right edge do nothing", async () => {
	const send = setMode();
	await show({});
	const row = rowOf(SCOUT);
	await drag(row, 200, 140);
	expect(row.hasAttribute("data-armed")).toBe(false);
	await lift(row, 140, 130);
	expect(row.style.transform).toBe("");
	await drag(row, 385, 150);
	await lift(row, 150);
	expect(row.style.transform).toBe("");
	expect(send).not.toHaveBeenCalled();
	expect(modeOf(SCOUT)).toEqual({ yolo: false, longRunning: false });
});

test("a read-only room only gives a little and shows no mark", async () => {
	const send = setMode();
	await show({});
	const row = rowOf(SEALED);
	expect(revealOf(row)).toBeNull();
	await drag(row, 300, 60);
	const pulled = Number.parseFloat(
		row.style.transform.replace(/translate3d\(-([\d.]+)px.*/, "$1"),
	);
	expect(pulled).toBeGreaterThan(0);
	expect(pulled).toBeLessThanOrEqual(24);
	expect(row.hasAttribute("data-armed")).toBe(false);
	await lift(row, 60);
	expect(row.style.transform).toBe("");
	expect(send).not.toHaveBeenCalled();
});

test("a lifted row and a row in arrange mode do not turn their modes", async () => {
	const send = setMode();
	await show({}, [{ id: FOLDER, name: "Work", rooms: [BUILD] }]);
	const row = rowOf(SCOUT);
	const item = row.closest("li") as HTMLElement;
	await page.act(() => touch(row, "pointerdown", 300, 100));
	for (let i = 0; i < 40 && !item.hasAttribute("data-lifted"); i += 1)
		await settle(50);
	expect(item.hasAttribute("data-lifted")).toBe(true);
	await page.act(() => {
		for (const x of [260, 200, 100]) touch(row, "pointermove", x, 100);
	});
	expect(row.style.transform).toBe("");
	await page.act(async () => {
		touch(row, "pointerup", 100, 100);
		await settle(80);
	});
	item.dataset.arranging = "";
	await swipeLeft(row);
	delete item.dataset.arranging;
	expect(send).not.toHaveBeenCalled();
});

test("a right swipe still marks read and turns no mode; a left swipe marks nothing read", async () => {
	const send = setMode();
	const read = readAll();
	await show({ [SCOUT]: 3 });
	const row = rowOf(SCOUT);
	await swipeLeft(row);
	expect(read).not.toHaveBeenCalled();
	expect(unreadCounts()[SCOUT]).toBe(3);
	expect(send).toHaveBeenCalledTimes(1);
	await drag(row, 60, 260);
	expect(revealOf(row)?.hasAttribute("data-shown")).toBe(false);
	await lift(row, 260);
	expect(read).toHaveBeenCalledTimes(1);
	expect(send).toHaveBeenCalledTimes(1);
});

test("the row springs back at once for someone who asked for less motion, and slides back otherwise", async () => {
	setMode();
	await show({});
	const row = rowOf(SCOUT);
	await swipeLeft(row);
	expect(row.style.transition).toContain("0ms");
	reduced = false;
	await swipeLeft(row);
	expect(row.style.transition).toContain("180ms");
});

test("a hold still opens the room's menu", async () => {
	setMode();
	await show({});
	const row = rowOf(SCOUT);
	await page.act(async () => {
		touch(row, "pointerdown", 100, 100);
		await settle(HOLD_MS + 80);
		touch(row, "pointerup", 100, 100);
		await settle(80);
	});
	expect(labels()).toContain("Yolo mode");
});

test("a refused change puts the modes back and says why", async () => {
	track(spyOn(api, "setMode")).mockRejectedValue(new Error("Not allowed here"));
	await show({});
	const row = rowOf(SCOUT);
	await swipeLeft(row);
	expect(modeOf(SCOUT)).toEqual({ yolo: false, longRunning: false });
	expect(row.querySelector(".badge-yolo")).toBeNull();
	expect(notice()).toContain("Not allowed here");
	expect(notice()).not.toContain("Yolo on");
});

test("a thread card and a temp knight's row turn no mode when swiped left", async () => {
	const send = setMode();
	const dismiss = track(spyOn(api, "dismissThread")).mockResolvedValue({
		dismissed: 1,
	});
	await show({});
	const card = document.querySelector<HTMLElement>(
		`.thread-card[data-thread="${DONE}"] .thread-link`,
	) as HTMLElement;
	await swipeLeft(card);
	expect(dismiss).not.toHaveBeenCalled();
	const head = document.querySelector<HTMLElement>(
		`.helper-group[data-parent="${BUILD}"] .helper-head`,
	);
	if (head?.getAttribute("aria-expanded") === "false") await page.click(head);
	const helper = rowOf(TEMP, "a.helper-link");
	await swipeLeft(helper);
	expect(helper.style.transform).toBe("");
	expect(send).not.toHaveBeenCalled();
});

/** A room's page in little: the drawer's own swipe on the whole page, and the drawer. */
function Room() {
	const switcher = useSwitcher(true);
	return (
		<div id="room" {...switcher.surface}>
			<button type="button" id="open" onClick={switcher.show}>
				open
			</button>
			<RoomSwitcher {...switcher.drawer} current={HOME} />
			<ActionMenuHost />
			<Toaster />
		</div>
	);
}

test("a row in the drawer swiped left still closes the drawer and turns no mode", async () => {
	const send = setMode();
	window.location.hash = "#/room/app%3Aagent.rs-guide";
	store.dispatch({ type: "rooms_loaded", rooms: ROOMS, pins: [], folders: [] });
	await page.render(<Room />);
	await page.click(document.querySelector("#open"));
	for (let i = 0; i < 160 && !document.querySelector("a.switcher-row"); i += 1)
		await page.act(() => settle(25));
	await page.act(() => settle(80));
	const drawer = () =>
		document.querySelector<HTMLElement>(".switcher")?.dataset.state;
	expect(drawer()).toBe("open");
	const row = rowOf(SCOUT, "a.switcher-row");
	expect(revealOf(row)).toBeNull();
	await swipeLeft(row);
	for (let i = 0; i < 40 && drawer() === "open"; i += 1)
		await page.act(() => settle(25));
	expect(drawer()).not.toBe("open");
	expect(send).not.toHaveBeenCalled();
});
