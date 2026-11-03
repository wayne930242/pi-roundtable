import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	spyOn,
	test,
} from "bun:test";
import type { ConfigView, RoomView } from "../src/api-types.ts";
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
import { setRouting } from "./lib/router.ts";
import { RoomsPage } from "./pages/rooms.tsx";

// Rooms of this file's own: the store is shared by the files of a run.
const HOME = "app:agent.rs-guide";
const SCOUT = "app:agent.rs-scout";
const BUILD = "app:agent.rs-build";
const DONE = "app:thread.0b5e7c1a-0000-4000-8000-0000000000a1";
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
	view(DONE, {
		kind: "thread",
		name: DONE.slice(DONE.indexOf(":") + 1),
		displayName: "Fix the build",
		parent: SCOUT,
		readOnly: true,
		closed: true,
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
const revealOf = (row: HTMLElement) =>
	row.parentElement?.querySelector<HTMLElement>(":scope > .read-reveal");

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
const readAll = () =>
	track(spyOn(bulkApi, "readAll")).mockResolvedValue({
		moved: [{ room: SCOUT, from: 4, to: 7 }],
	});

test("a row swiped right past the threshold uncovers the quiet Read mark, springs back, and marks its room read once with an undo", async () => {
	const send = readAll();
	await show();
	const row = rowOf(SCOUT);
	await drag(row, 60, 260);
	expect(row.style.transform).toContain("translate3d");
	expect(row.hasAttribute("data-armed")).toBe(true);
	const reveal = revealOf(row);
	expect(reveal?.hasAttribute("data-shown")).toBe(true);
	expect(reveal?.getAttribute("aria-hidden")).toBe("true");
	expect(reveal?.textContent).toBe("Read");
	expect(reveal?.querySelector("svg")).not.toBeNull();
	await lift(row, 260);
	expect(send).toHaveBeenCalledTimes(1);
	expect(send.mock.calls[0]?.[0]).toEqual([SCOUT]);
	expect(row.style.transform).toBe("");
	expect(row.hasAttribute("data-armed")).toBe(false);
	expect(reveal?.hasAttribute("data-shown")).toBe(false);
	expect(unreadCounts()[SCOUT]).toBeUndefined();
	expect(notice()).toContain("Marked 1 room as read");
	expect(notice()).toContain("Undo");
	// The click the lift brings does not open the room.
	window.location.hash = "#/rooms";
	await page.click(row);
	expect(window.location.hash).toBe("#/rooms");
});

test("the swiped row's badge is gone the moment it is let go, before the server answers", async () => {
	let answer: (value: { moved: [] }) => void = () => undefined;
	track(spyOn(bulkApi, "readAll")).mockReturnValue(
		new Promise((resolve) => {
			answer = resolve;
		}),
	);
	await show();
	const row = rowOf(SCOUT);
	expect(row.querySelector(".unread-mark")).not.toBeNull();
	await drag(row, 60, 260);
	await page.act(() => touch(row, "pointerup", 260, 102));
	expect(unreadCounts()[SCOUT]).toBeUndefined();
	expect(row.querySelector(".unread-mark")).toBeNull();
	await page.act(async () => {
		answer({ moved: [] });
		await settle();
	});
});

test("home's row marks read too", async () => {
	const send = readAll();
	await show({ [HOME]: 2 });
	const row = rowOf(HOME);
	await drag(row, 60, 260);
	await lift(row, 260);
	expect(send.mock.calls[0]?.[0]).toEqual([HOME]);
});

test("a short swipe, a swipe left, a scroll and a swipe from the screen edge mark nothing", async () => {
	const send = readAll();
	await show();
	const row = rowOf(SCOUT);
	await drag(row, 60, 130);
	await lift(row, 130, 130);
	expect(row.style.transform).toBe("");
	await drag(row, 60, 100, 120);
	await lift(row, 100);
	expect(row.style.transform).toBe("");
	await drag(row, 200, 60);
	await lift(row, 60);
	expect(row.style.transform).toBe("");
	await drag(row, 10, 260);
	await lift(row, 260);
	expect(row.style.transform).toBe("");
	expect(send).not.toHaveBeenCalled();
	expect(unreadCounts()[SCOUT]).toBe(3);
});

test("a row with nothing unread only gives a little, shows no mark, and calls nothing", async () => {
	const send = readAll();
	await show({});
	const row = rowOf(BUILD);
	await drag(row, 60, 300);
	const pulled = Number.parseFloat(
		row.style.transform.replace(/translate3d\(([\d.]+)px.*/, "$1"),
	);
	expect(pulled).toBeGreaterThan(0);
	expect(pulled).toBeLessThanOrEqual(24);
	expect(row.hasAttribute("data-armed")).toBe(false);
	expect(revealOf(row)?.hasAttribute("data-shown")).toBe(false);
	await lift(row, 300);
	expect(row.style.transform).toBe("");
	expect(send).not.toHaveBeenCalled();
});

test("the row springs back at once for someone who asked for less motion, and slides back otherwise", async () => {
	readAll();
	await show();
	const row = rowOf(SCOUT);
	await drag(row, 60, 260);
	await lift(row, 260);
	expect(row.style.transition).toContain("0ms");
	reduced = false;
	seedUnread({ [SCOUT]: 3 });
	await drag(row, 60, 260);
	await lift(row, 260);
	expect(row.style.transition).toContain("180ms");
});

test("a hold still opens the room's menu, which offers Mark as read only while something is unread", async () => {
	const send = readAll();
	await show({ [SCOUT]: 3 });
	const row = rowOf(SCOUT);
	await page.act(async () => {
		touch(row, "pointerdown", 100, 100);
		await settle(HOLD_MS + 80);
		touch(row, "pointerup", 100, 100);
		await settle(80);
	});
	expect(labels()[0]).toBe("Mark as read");
	await page.click(menuItems()[0] as HTMLElement);
	await settle(80);
	expect(send).toHaveBeenCalledTimes(1);
	expect(send.mock.calls[0]?.[0]).toEqual([SCOUT]);
	expect(roomMenu(SCOUT)?.items.map((one) => one.id)).not.toContain("read");
	seedUnread({ [BUILD]: 1 });
	expect(roomMenu(BUILD)?.items[0]?.id).toBe("read");
	expect(roomMenu(BUILD)?.items[0]?.icon).toBe("check");
	expect(ZH_TW["Mark as read"]).toBeDefined();
	expect(ZH_TW.Read).toBeDefined();
});

test("a sideways move before the hold gives the hold up; a resting finger still lifts the row, and a lifted row does not swipe", async () => {
	const send = readAll();
	await show({ [SCOUT]: 3, [BUILD]: 2 }, [
		{ id: FOLDER, name: "Work", rooms: [BUILD] },
	]);
	const row = rowOf(SCOUT);
	const item = row.closest("li") as HTMLElement;
	await drag(row, 60, 160);
	await page.act(() => settle(HOLD_MS + 80));
	expect(item.hasAttribute("data-lifted")).toBe(false);
	expect(menuItems()).toEqual([]);
	await lift(row, 160);
	send.mockClear();

	await page.act(() => touch(row, "pointerdown", 100, 100));
	for (let i = 0; i < 40 && !item.hasAttribute("data-lifted"); i += 1) {
		await settle(50);
	}
	expect(item.hasAttribute("data-lifted")).toBe(true);
	await page.act(() => {
		for (const x of [140, 200, 260]) touch(row, "pointermove", x, 100);
	});
	expect(row.style.transform).toBe("");
	await page.act(async () => {
		touch(row, "pointerup", 260, 100);
		await settle(80);
	});
	expect(send).not.toHaveBeenCalled();
});

test("a swipe on a thread card under a row clears the thread and leaves the room unread", async () => {
	const send = readAll();
	const dismiss = track(spyOn(api, "dismissThread")).mockResolvedValue({
		dismissed: 1,
	});
	await show({ [SCOUT]: 3 });
	const card = document.querySelector<HTMLElement>(
		`.thread-card[data-thread="${DONE}"]`,
	) as HTMLElement;
	Object.defineProperty(card, "offsetWidth", {
		value: 300,
		configurable: true,
	});
	const link = card.querySelector(".thread-link") as HTMLElement;
	await drag(link, 60, 260);
	expect(rowOf(SCOUT).style.transform).toBe("");
	await lift(link, 260);
	expect(dismiss).toHaveBeenCalledWith(DONE);
	expect(send).not.toHaveBeenCalled();
	expect(unreadCounts()[SCOUT]).toBe(3);
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

test("a row in the open drawer marks its room read, and the drawer stays where it is", async () => {
	const send = readAll();
	window.location.hash = "#/room/app%3Aagent.rs-guide";
	store.dispatch({ type: "rooms_loaded", rooms: ROOMS, pins: [], folders: [] });
	seedUnread({ [SCOUT]: 3 });
	await page.render(<Room />);
	await page.click(document.querySelector("#open"));
	for (let i = 0; i < 160 && !document.querySelector("a.switcher-row"); i += 1)
		await page.act(() => settle(25));
	await page.act(() => settle(80));
	const drawer = () =>
		document.querySelector<HTMLElement>(".switcher")?.dataset.state;
	expect(drawer()).toBe("open");
	const row = rowOf(SCOUT, "a.switcher-row");
	await drag(row, 60, 260);
	expect(drawer()).toBe("open");
	expect(revealOf(row)?.hasAttribute("data-shown")).toBe(true);
	await lift(row, 260);
	expect(send).toHaveBeenCalledTimes(1);
	expect(send.mock.calls[0]?.[0]).toEqual([SCOUT]);
	expect(drawer()).toBe("open");
	expect(row.style.transform).toBe("");
});
