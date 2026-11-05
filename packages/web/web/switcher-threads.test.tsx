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
import { RoomSwitcher, useSwitcher } from "./components/switcher.tsx";
import { drawerThreads } from "./components/switcher-list.tsx";
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
import { setRouting } from "./lib/router.ts";

// Rooms of this file's own: the store is shared by the files of a run.
const HOME = "app:agent.st-guide";
const SCOUT = "app:agent.st-scout";
const BUILD = "app:agent.st-build";
const RUN = "app:thread.0b5e7c1a-0000-4000-8000-0000000000c1";
const DONE = "app:thread.0b5e7c1a-0000-4000-8000-0000000000c2";
const MORE = "app:thread.0b5e7c1a-0000-4000-8000-0000000000c3";
const TEMP = "app:agent.st-temp";

const config: ConfigView = {
	title: "Console",
	panes: ["rooms"],
	timeZone: "UTC",
	look: "modern",
};

const short = (key: string) =>
	key.slice(key.indexOf(".") + 1).replace(/^st-/, "");
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
const thread = (key: string, title: string, over: Partial<RoomView> = {}) =>
	view(key, {
		kind: "thread",
		name: key.slice(key.indexOf(":") + 1),
		displayName: title,
		parent: SCOUT,
		readOnly: true,
		...over,
	});

const ROOMS: RoomView[] = [
	view(HOME, { home: true }),
	view(SCOUT),
	view(BUILD),
	thread(RUN, "Port the parser"),
	thread(DONE, "Fix the build", { closed: true }),
	view(TEMP, { helper: { parent: SCOUT, parentName: "scout" } }),
];

let page: TestPage;
const stored = new Map<string, string>();
const spies: { mockRestore(): void }[] = [];
const track = <T extends { mockRestore(): void }>(spy: T): T => {
	spies.push(spy);
	return spy;
};

beforeAll(async () => {
	await loadKit();
	await import("./lib/read-swipe.ts");
	await import("./lib/thread-cards.ts");
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
	window.location.hash = "#/room/app%3Aagent.st-guide";
	stored.clear();
	drawerThreads.reload();
	reloadCollapsed();
	store.dispatch({ type: "rooms_loaded", rooms: ROOMS, pins: [], folders: [] });
});
afterEach(async () => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	await page.act(() => closeMenu());
	await page.render(null);
	store.dispatch({ type: "rooms_loaded", rooms: [], pins: [], folders: [] });
	seedUnread(
		Object.fromEntries(Object.keys(unreadCounts()).map((k) => [k, 0])),
	);
});

const settle = (ms = 40) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

function Room(props: { current: string }) {
	const switcher = useSwitcher(true);
	return (
		<div id="room" {...switcher.surface}>
			<button type="button" id="open" onClick={switcher.show}>
				open
			</button>
			<RoomSwitcher {...switcher.drawer} current={props.current} />
			<ActionMenuHost />
			<Toaster />
		</div>
	);
}

const drawer = () =>
	document.querySelector<HTMLElement>(".switcher")?.dataset.state;
const toggleOf = (key: string) =>
	document
		.querySelector(`a.switcher-row[data-room="${key}"]`)
		?.parentElement?.querySelector<HTMLElement>(
			":scope > .switcher-threads-toggle",
		) ?? null;
const cardsUnder = (key: string) =>
	[
		...(document
			.querySelector(`a.switcher-row[data-room="${key}"]`)
			?.parentElement?.querySelectorAll<HTMLElement>(
				".thread-title, .helper-link strong",
			) ?? []),
	].map((one) => one.textContent);

async function openDrawer(current = HOME) {
	await page.render(
		<ConfigContext.Provider value={config}>
			<Room current={current} />
		</ConfigContext.Provider>,
	);
	await page.click(document.querySelector("#open"));
	for (let i = 0; i < 160 && !document.querySelector("a.switcher-row"); i += 1)
		await page.act(() => settle(25));
	await page.act(() => settle(80));
}
/** Waits for the lazy thread cards under an opened row. */
async function cardsLoad() {
	for (let i = 0; i < 160 && !document.querySelector(".thread-card"); i += 1)
		await page.act(() => settle(25));
	await page.act(() => settle(80));
}

function touch(
	target: Element,
	type: "pointerdown" | "pointermove" | "pointerup",
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
async function swipe(target: HTMLElement, from: number, to: number) {
	Object.defineProperty(target, "offsetWidth", {
		value: 300,
		configurable: true,
	});
	await page.act(() => touch(target, "pointerdown", from, 100));
	for (let i = 1; i <= 6; i += 1)
		await page.act(() =>
			touch(target, "pointermove", from + ((to - from) * i) / 6, 101),
		);
	await page.act(async () => {
		touch(target, "pointerup", to, 102);
		await settle();
	});
}

test("only a room with threads or temp knights has the toggle, showing their count, closed by default", async () => {
	await openDrawer();
	expect(toggleOf(HOME)).toBeNull();
	expect(toggleOf(BUILD)).toBeNull();
	const toggle = toggleOf(SCOUT) as HTMLElement;
	expect(toggle.textContent).toBe("3");
	expect(toggle.getAttribute("aria-expanded")).toBe("false");
	expect(toggle.getAttribute("aria-label")).toBe("Show threads");
	expect(cardsUnder(SCOUT)).toEqual([]);
	expect(ZH_TW["Show threads"]).toBeDefined();
	expect(ZH_TW["Hide threads"]).toBeDefined();
});

test("the open room starts with its threads open; so does the room of an open thread", async () => {
	await openDrawer(SCOUT);
	expect(toggleOf(SCOUT)?.getAttribute("aria-expanded")).toBe("true");
	await page.render(null);
	await openDrawer(RUN);
	expect(toggleOf(SCOUT)?.getAttribute("aria-expanded")).toBe("true");
});

test("the toggle opens the same thread list as the rooms page, without navigating or closing the drawer, and is remembered", async () => {
	await openDrawer();
	const before = window.location.hash;
	await page.click(toggleOf(SCOUT));
	await cardsLoad();
	expect(drawer()).toBe("open");
	expect(window.location.hash).toBe(before);
	const toggle = toggleOf(SCOUT) as HTMLElement;
	expect(toggle.getAttribute("aria-expanded")).toBe("true");
	expect(toggle.getAttribute("aria-label")).toBe("Hide threads");
	const body = document.getElementById(
		toggle.getAttribute("aria-controls") ?? "",
	);
	expect(body?.querySelector(".thread-group")).not.toBeNull();
	expect(body?.querySelector(".helper-group")).not.toBeNull();
	expect(cardsUnder(SCOUT)).toContain("Port the parser");
	expect(cardsUnder(SCOUT)).toContain("temp");
	// Remembered across a remount.
	await page.render(null);
	await openDrawer();
	expect(toggleOf(SCOUT)?.getAttribute("aria-expanded")).toBe("true");
	await page.click(toggleOf(SCOUT));
	expect(toggleOf(SCOUT)?.getAttribute("aria-expanded")).toBe("false");
	await page.render(null);
	await openDrawer(SCOUT);
	expect(toggleOf(SCOUT)?.getAttribute("aria-expanded")).toBe("false");
});

test("the count and the list follow the threads as they open", async () => {
	await openDrawer(SCOUT);
	await cardsLoad();
	await page.act(() =>
		store.dispatch({
			type: "rooms_loaded",
			rooms: [...ROOMS, thread(MORE, "Write the notes")],
			pins: [],
			folders: [],
		}),
	);
	await page.act(() => settle(80));
	expect(toggleOf(SCOUT)?.textContent).toBe("4");
	expect(cardsUnder(SCOUT)).toContain("Write the notes");
});

test("tapping a thread card or a temp knight goes there and closes the drawer", async () => {
	for (const [name, key] of [
		["Port the parser", RUN],
		["temp", TEMP],
	] as const) {
		await openDrawer(SCOUT);
		await cardsLoad();
		const link = [
			...document.querySelectorAll<HTMLElement>(".switcher-threads a"),
		].find((one) => one.textContent?.includes(name));
		await page.click(link ?? null);
		await page.act(() => settle(80));
		expect(drawer()).toBe("closed");
		expect(decodeURIComponent(window.location.hash)).toBe(`#/room/${key}`);
		await page.render(null);
		window.location.hash = "#/room/app%3Aagent.st-guide";
	}
});

test("a swipe on a thread card clears it, leaves the room unread and the drawer open", async () => {
	const send = track(spyOn(bulkApi, "readAll")).mockResolvedValue({
		moved: [],
	});
	const dismiss = track(spyOn(api, "dismissThread")).mockResolvedValue({
		dismissed: 1,
	});
	seedUnread({ [SCOUT]: 3 });
	await openDrawer(SCOUT);
	await cardsLoad();
	(
		document.querySelector(".switcher-threads details") as HTMLDetailsElement
	).open = true;
	const card = document.querySelector<HTMLElement>(
		`.thread-card[data-thread="${DONE}"]`,
	) as HTMLElement;
	const link = card.querySelector(".thread-link") as HTMLElement;
	Object.defineProperty(card, "offsetWidth", {
		value: 300,
		configurable: true,
	});
	// A swipe left on a card is not the drawer's swipe to close.
	await swipe(link, 260, 40);
	expect(drawer()).toBe("open");
	await swipe(link, 60, 260);
	await page.act(() => settle(400));
	expect(dismiss).toHaveBeenCalledWith(DONE);
	expect(send).not.toHaveBeenCalled();
	expect(unreadCounts()[SCOUT]).toBe(3);
	expect(drawer()).toBe("open");
});

test("a room row with threads still swipes to read, and a hold still opens its menu", async () => {
	const send = track(spyOn(bulkApi, "readAll")).mockResolvedValue({
		moved: [{ room: SCOUT, from: 4, to: 7 }],
	});
	seedUnread({ [SCOUT]: 3 });
	await openDrawer(SCOUT);
	await cardsLoad();
	const row = document.querySelector<HTMLElement>(
		`a.switcher-row[data-room="${SCOUT}"]`,
	) as HTMLElement;
	await swipe(row, 60, 260);
	expect(send).toHaveBeenCalledTimes(1);
	expect(send.mock.calls[0]?.[0]).toEqual([SCOUT]);
	expect(drawer()).toBe("open");
	seedUnread({ [SCOUT]: 2 });
	await page.act(async () => {
		touch(row, "pointerdown", 100, 100);
		await settle(HOLD_MS + 80);
		touch(row, "pointerup", 100, 100);
		await settle(80);
	});
	expect(
		[...document.querySelectorAll('[role^="menuitem"]')].map(
			(one) => one.textContent,
		)[0],
	).toBe("Mark as read");
});
