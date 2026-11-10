import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	spyOn,
	test,
} from "bun:test";
import type { ConfigView, RoomMessage, RoomView } from "../src/api-types.ts";
import { ZH_TW } from "../src/i18n/zh-tw.ts";
import { ActionMenuHost } from "./components/action-menu.tsx";
import { RoomSwitcher, useSwitcher } from "./components/switcher.tsx";
import { Toaster } from "./components/toaster.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { closeMenu } from "./lib/action-menu.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { bulkApi } from "./lib/bulk-api.ts";
import { lastChip, rememberChip } from "./lib/chat-chip.ts";
import { ConfigContext } from "./lib/config.ts";
import { reloadCollapsed } from "./lib/folds.ts";
import { setHomeMode } from "./lib/home-mode.ts";
import { seedUnread, unreadCounts } from "./lib/host-state.ts";
import { loadKit } from "./lib/kit.ts";
import { HOLD_MS } from "./lib/long-press.ts";
import { setRouting } from "./lib/router.ts";

// Rooms of this file's own: the store is shared by the files of a run.
const HOME = "app:agent.sc-guide";
const SCOUT = "app:agent.sc-scout";
const BUILD = "app:agent.sc-build";
const NEWS = "app:agent.sc-news";
const LOGS = "app:agent.sc-logs";
const QUIET = "app:agent.sc-quiet";
const SECRET = "app:agent.sc-secret";
const RUN = "app:thread.0b5e7c1a-0000-4000-8000-0000000000d1";
const DONE = "app:thread.0b5e7c1a-0000-4000-8000-0000000000d2";
const TEMP = "app:agent.sc-temp";
const F1 = "folder.00000000-0000-4000-8000-0000000000d1";
const F2 = "folder.00000000-0000-4000-8000-0000000000d2";

const config: ConfigView = {
	title: "Console",
	panes: ["rooms"],
	timeZone: "UTC",
	look: "modern",
	app: { surface: "app", protocol: "roundtable.app.v1", home: "chats" },
};

const short = (key: string) =>
	key.slice(key.indexOf(".") + 1).replace(/^sc-/, "");
const said = (key: string, at: string): RoomMessage => ({
	id: 1,
	room: key,
	kind: "agent",
	author: "x",
	text: `about ${short(key)}`,
	files: [],
	at,
});
const view = (
	key: string,
	minute: number,
	over: Partial<RoomView> = {},
): RoomView => ({
	key,
	kind: "agent",
	name: short(key),
	displayName: short(key),
	home: false,
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
	last: said(key, `2026-10-28T10:${String(minute).padStart(2, "0")}:00.000Z`),
	...over,
});
const thread = (key: string, title: string, over: Partial<RoomView> = {}) =>
	view(key, 0, {
		kind: "thread",
		name: key.slice(key.indexOf(":") + 1),
		displayName: title,
		parent: SCOUT,
		readOnly: true,
		...over,
	});

// Newest first among the rest: news, quiet, scout; build and logs are pinned, secret is hidden.
const ROOMS: RoomView[] = [
	view(HOME, 1, { home: true }),
	view(SCOUT, 20),
	view(BUILD, 30),
	view(NEWS, 50),
	view(LOGS, 40),
	view(QUIET, 45),
	view(SECRET, 55),
	thread(RUN, "Port the parser"),
	thread(DONE, "Fix the build", { closed: true }),
	view(TEMP, 0, { helper: { parent: SCOUT, parentName: "scout" } }),
];
const LAYOUT = {
	pins: [LOGS, BUILD],
	hidden: [SECRET],
	folders: [
		{ id: F1, name: "Work", rooms: [SCOUT] },
		{ id: F2, name: "Play", rooms: [NEWS] },
	],
};

let page: TestPage;
let attachModeSwipe: typeof import("./lib/mode-swipe.ts").attachModeSwipe;
const stored = new Map<string, string>();
const spies: { mockRestore(): void }[] = [];
const track = <T extends { mockRestore(): void }>(spy: T): T => {
	spies.push(spy);
	return spy;
};

beforeAll(async () => {
	await loadKit();
	page = await openPage();
	// After the DOM is in place: the swipes' reveal brings in react-dom, which has to see the page to listen for input.
	await import("./lib/read-swipe.ts");
	await import("./lib/thread-cards.ts");
	({ attachModeSwipe } = await import("./lib/mode-swipe.ts"));
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
	setHomeMode("rooms");
	await page.unmount();
	await releaseDom();
});
beforeEach(() => {
	window.innerWidth = 390;
	window.location.hash = `#/room/${encodeURIComponent(SCOUT)}`;
	stored.clear();
	reloadCollapsed();
	rememberChip("all");
	setHomeMode("chats");
	store.dispatch({
		type: "rooms_loaded",
		rooms: ROOMS,
		pins: LAYOUT.pins,
		hidden: LAYOUT.hidden,
		folders: LAYOUT.folders,
	});
	seedUnread(Object.fromEntries(ROOMS.map((one) => [one.key, 0])));
});
afterEach(async () => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	await page.act(() => closeMenu());
	await page.render(null);
	store.dispatch({
		type: "rooms_loaded",
		rooms: [],
		pins: [],
		hidden: [],
		folders: [],
	});
	seedUnread({});
});

const settle = (ms = 40) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
const until = async (done: () => boolean, ms = 4000) => {
	const stop = Date.now() + ms;
	while (!done() && Date.now() < stop) await page.act(() => settle(25));
};
const q = <T extends Element = HTMLElement>(selector: string) =>
	document.querySelector<T>(selector);
const all = <T extends Element = HTMLElement>(selector: string) => [
	...document.querySelectorAll<T>(selector),
];
const names = (selector: string) => all(selector).map((one) => one.textContent);

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

const drawer = () => q(".switcher")?.dataset.state;
const row = (key: string): HTMLElement => {
	const found = q(`.switcher-chats a.chat-row[data-room="${key}"]`);
	if (!found) throw new Error(`no row ${key}`);
	Object.defineProperty(found, "offsetWidth", {
		value: 300,
		configurable: true,
	});
	return found;
};
const here = () => decodeURIComponent(window.location.hash);

async function openDrawer(current = SCOUT) {
	await page.render(
		<ConfigContext.Provider value={config}>
			<Room current={current} />
		</ConfigContext.Provider>,
	);
	await page.click(q("#open"));
	await until(() => q(".switcher-chats .chat-row") !== null);
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

test("the drawer lists the home's rows: Home first, then the rest by latest activity, with the pinned and hidden rooms out of the list", async () => {
	await openDrawer();
	expect(q(".switcher-list")).toBeNull();
	expect(names(".switcher-chats .chat-list .chat-row strong")).toEqual([
		"guide",
		"news",
		"quiet",
		"scout",
	]);
	// Each row is the home's: a time, a one-line preview, and its folder where the list mixes them.
	const news = row(NEWS);
	expect(news.classList.contains("room-row")).toBe(true);
	expect(news.querySelector(".room-row-preview")?.textContent).toContain(
		"about news",
	);
	expect(news.querySelector(".folder-tag")?.textContent).toBe("Play");
	expect(row(SCOUT).getAttribute("aria-current")).toBe("page");
	expect(row(SCOUT).querySelector(".chat-pill")?.textContent).toBe("2 threads");
});

test("the folder tabs are the home's, open on the tab the home last had, and a tab chosen here is the home's too", async () => {
	rememberChip(F1);
	await openDrawer();
	expect(names(".switcher-chats .chips .chip-label")).toEqual([
		"All",
		"Work",
		"Play",
		"Other",
	]);
	const tabs = all<HTMLButtonElement>(".switcher-chats .chips .chip");
	expect(tabs.map((one) => one.getAttribute("aria-pressed"))).toEqual([
		"false",
		"true",
		"false",
		"false",
	]);
	expect(names(".switcher-chats .chat-list .chat-row strong")).toEqual([
		"scout",
	]);
	await page.click(tabs[3] ?? null);
	expect(lastChip()).toBe("other");
	// Home is in no folder, so it leads the list of all only.
	expect(names(".switcher-chats .chat-list .chat-row strong")).toEqual([
		"quiet",
	]);
});

test("with a folder chosen, the rooms of other folders with something unread lead under Other unread", async () => {
	seedUnread({ [NEWS]: 4 });
	rememberChip(F1);
	await openDrawer();
	expect(q(".switcher-chats .elsewhere h2")?.textContent).toBe("Other unread");
	expect(names(".switcher-chats .elsewhere .chat-row strong")).toEqual([
		"news",
	]);
	expect(q(".switcher-chats .elsewhere .folder-tag")?.textContent).toBe("Play");
	expect(q(".switcher-chats .folder-section h2")?.textContent).toBe("Work");
	// All lists everything already, so it has no such section.
	await page.click(all(".switcher-chats .chips .chip")[0] ?? null);
	expect(q(".switcher-chats .elsewhere")).toBeNull();
});

test("a host without a folder has no tabs; the pinned rooms are in a dock under the list, in pin order, with their badges", async () => {
	store.dispatch({
		type: "rooms_loaded",
		rooms: ROOMS,
		pins: LAYOUT.pins,
		hidden: LAYOUT.hidden,
		folders: [],
	});
	seedUnread({ [LOGS]: 3 });
	await openDrawer();
	expect(q(".switcher-chats .chips")).toBeNull();
	const dock = q(".switcher-chats .pins.pin-dock");
	expect(dock).not.toBeNull();
	expect(names(".switcher-chats .pin-dock .pin-name")).toEqual([
		"logs",
		"build",
	]);
	expect(q(".switcher-chats .pin-dock .pin-count")?.textContent).toBe("3");
	// The dock is under the list, above the bar.
	const parts = [...(q(".switcher-chats")?.children ?? [])].map(
		(one) => one.className,
	);
	expect(parts.findIndex((one) => one.includes("pin-dock"))).toBeGreaterThan(
		parts.findIndex((one) => one.includes("switcher-scroll")),
	);
	expect(names(".switcher-chats .chat-list .chat-row strong")).not.toContain(
		"logs",
	);
});

test("the room's dispatch threads head the drawer, whether the open room is the knight or one of its threads, with the open card marked", async () => {
	await openDrawer(SCOUT);
	const section = q(".switcher-chats-threads");
	expect(section?.querySelector("h2")?.textContent).toBe(
		"scout's dispatch threads",
	);
	await until(() => q(".switcher-chats-threads .thread-card") !== null);
	expect(
		names(
			".switcher-chats-threads .thread-title, .switcher-chats-threads .helper-link strong",
		),
	).toEqual(expect.arrayContaining(["Port the parser", "temp"]));
	// It is the first thing in the scrolling list.
	expect(q(".switcher-scroll")?.firstElementChild).toBe(section);
	await page.render(null);
	await openDrawer(RUN);
	await until(() => q(".switcher-chats-threads .thread-card") !== null);
	expect(q(".switcher-chats-threads h2")?.textContent).toBe(
		"scout's dispatch threads",
	);
	const current = q(
		`.switcher-chats-threads .thread-card[data-thread="${RUN}"]`,
	);
	expect(current?.querySelector("[aria-current]")).not.toBeNull();
	expect(ZH_TW["{name}'s dispatch threads"]).toContain("{name}");
});

test("a room with no threads has no such section, and the threads of another room do not show", async () => {
	await openDrawer(BUILD);
	expect(q(".switcher-chats-threads")).toBeNull();
	expect(row(SCOUT).querySelector(".chat-pill")?.textContent).toBe("2 threads");
});

test("tapping a thread card goes there and closes the drawer; tapping a row does the same, and the open room's own row only closes it", async () => {
	await openDrawer(SCOUT);
	await until(() => q(".switcher-chats-threads .thread-card") !== null);
	const link = all(".switcher-chats-threads a").find((one) =>
		one.textContent?.includes("Port the parser"),
	);
	await page.click(link ?? null);
	await page.act(() => settle(80));
	expect(drawer()).toBe("closed");
	expect(here()).toBe(`#/room/${RUN}`);
	await page.render(null);
	window.location.hash = `#/room/${encodeURIComponent(SCOUT)}`;
	await openDrawer(SCOUT);
	await page.click(row(NEWS));
	await page.act(() => settle(80));
	expect(drawer()).toBe("closed");
	expect(here()).toBe(`#/room/${NEWS}`);
	await page.render(null);
	window.location.hash = `#/room/${encodeURIComponent(SCOUT)}`;
	await openDrawer(SCOUT);
	await page.click(row(SCOUT));
	await page.act(() => settle(80));
	expect(drawer()).toBe("closed");
	expect(here()).toBe(`#/room/${SCOUT}`);
});

test("a pin in the dock goes to its room and closes the drawer", async () => {
	await openDrawer(SCOUT);
	await page.click(q(`.switcher-chats a.pin[data-room-pin="${BUILD}"]`));
	await page.act(() => settle(80));
	expect(drawer()).toBe("closed");
	expect(here()).toBe(`#/room/${BUILD}`);
});

test("a swipe left on a row closes the drawer and turns no mode; a swipe on the mode swipe's own rows still turns them", async () => {
	const set = track(spyOn(api, "setMode")).mockResolvedValue({
		mode: { yolo: true, longRunning: false },
	});
	await openDrawer(SCOUT);
	await swipe(row(NEWS), 260, 40);
	await page.act(() => settle(80));
	expect(drawer()).toBe("closed");
	expect(set).not.toHaveBeenCalled();
	// The same row outside a drawer is the mode swipe's.
	const outside = document.createElement("div");
	outside.innerHTML = `<ul><li><a class="room-row chat-row" data-room="${NEWS}" href="#">news</a></li></ul>`;
	document.body.append(outside);
	const detach = attachModeSwipe(outside);
	try {
		const link = outside.querySelector("a") as HTMLElement;
		Object.defineProperty(link, "offsetWidth", {
			value: 300,
			configurable: true,
		});
		await swipe(link, 260, 40);
		await page.act(() => settle(80));
		expect(set).toHaveBeenCalledTimes(1);
	} finally {
		detach();
		outside.remove();
	}
});

test("a swipe left over rows that sit in a drawer is not the mode swipe's, wherever the drawer's list is attached", async () => {
	const set = track(spyOn(api, "setMode")).mockResolvedValue({
		mode: { yolo: true, longRunning: false },
	});
	const shell = document.createElement("div");
	shell.className = "switcher";
	shell.innerHTML = `<div class="switcher-panel"><ul><li><a class="room-row chat-row" data-room="${NEWS}" href="#">news</a></li></ul></div>`;
	document.body.append(shell);
	const detach = attachModeSwipe(shell);
	try {
		const link = shell.querySelector("a") as HTMLElement;
		Object.defineProperty(link, "offsetWidth", {
			value: 300,
			configurable: true,
		});
		await swipe(link, 260, 40);
		await page.act(() => settle(80));
		expect(set).not.toHaveBeenCalled();
	} finally {
		detach();
		shell.remove();
	}
});

test("a swipe right on a row marks its room read and leaves the drawer open", async () => {
	const send = track(spyOn(bulkApi, "readAll")).mockResolvedValue({
		moved: [{ room: NEWS, from: 4, to: 7 }],
	});
	seedUnread({ [NEWS]: 4 });
	await openDrawer(SCOUT);
	await swipe(row(NEWS), 60, 260);
	expect(send).toHaveBeenCalledTimes(1);
	expect(send.mock.calls[0]?.[0]).toEqual([NEWS]);
	expect(unreadCounts()[NEWS]).toBeUndefined();
	expect(drawer()).toBe("open");
});

test("a swipe left that starts on the folder tabs, or on a dock that scrolls, does not close the drawer; elsewhere it does", async () => {
	await openDrawer(SCOUT);
	const tab = all(".switcher-chats .chips .chip")[1] as HTMLElement;
	await swipe(tab, 260, 40);
	expect(drawer()).toBe("open");
	// A dock of more than four pins scrolls sideways, as the browser tells `blocksSwipe`.
	const dock = q(".switcher-chats .pin-dock") as HTMLElement;
	dock.style.overflowX = "auto";
	Object.defineProperty(dock, "scrollWidth", {
		value: 600,
		configurable: true,
	});
	Object.defineProperty(dock, "clientWidth", {
		value: 296,
		configurable: true,
	});
	await swipe(dock.querySelector("a") as HTMLElement, 260, 40);
	expect(drawer()).toBe("open");
	await swipe(q(".switcher-chats .switcher-bar") as HTMLElement, 260, 40);
	await page.act(() => settle(80));
	expect(drawer()).toBe("closed");
});

test("the search is in the bar under the list: it hides the tabs and the dock, lists matching rooms pinned or not, and Enter picks the first", async () => {
	await openDrawer(SCOUT);
	const input = q<HTMLInputElement>(".switcher-bar input");
	expect(input?.getAttribute("aria-label")).toBe("Find a room");
	await page.act(() => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(input, "u");
		input?.dispatchEvent(new Event("input", { bubbles: true }));
	});
	expect(q(".switcher-chats .chips")).toBeNull();
	expect(q(".switcher-chats .pin-dock")).toBeNull();
	expect(q(".switcher-chats-threads")).toBeNull();
	// u: build (pinned), guide, quiet, scout; the hidden room is not among them.
	expect(names(".switcher-chats .chat-row strong")).toEqual([
		"build",
		"guide",
		"quiet",
		"scout",
	]);
	await page.act(() => {
		input?.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
		);
	});
	await page.act(() => settle(80));
	expect(drawer()).toBe("closed");
	expect(here()).toBe(`#/room/${BUILD}`);
});

test("a search for a hidden room finds nothing", async () => {
	await openDrawer(SCOUT);
	const input = q<HTMLInputElement>(".switcher-bar input");
	await page.act(() => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(input, "secret");
		input?.dispatchEvent(new Event("input", { bubbles: true }));
	});
	expect(all(".switcher-chats .chat-row")).toEqual([]);
});

test("the bar's Home goes to the rooms and closes the drawer, and its plus opens the add menu through the drawer", async () => {
	await openDrawer(SCOUT);
	const [home, add] = all<HTMLButtonElement>(".switcher-bar button");
	expect(home?.getAttribute("aria-label")).toBe("Home");
	expect(add?.getAttribute("aria-label")).toBe("Add");
	await page.click(home ?? null);
	await page.act(() => settle(80));
	expect(drawer()).toBe("closed");
	expect(here()).toBe("#/rooms");
	await page.render(null);
	await openDrawer(SCOUT);
	await page.click(all<HTMLButtonElement>(".switcher-bar button")[1] ?? null);
	await until(() => all('[role^="menuitem"]').length > 0);
	expect(all('[role^="menuitem"]').length).toBeGreaterThan(0);
});

test("a hold on a row opens the room's menu, and an item that leaves the room closes the drawer first", async () => {
	await openDrawer(SCOUT);
	const target = row(NEWS);
	await page.act(async () => {
		touch(target, "pointerdown", 100, 100);
		await settle(HOLD_MS + 80);
		touch(target, "pointerup", 100, 100);
		await settle(80);
	});
	await until(() => all('[role^="menuitem"]').length > 0);
	const move = all('[role^="menuitem"]').find((one) =>
		one.textContent?.includes("Move to folder"),
	);
	expect(move).toBeDefined();
	await page.click(move ?? null);
	await page.act(() => settle(120));
	expect(drawer()).toBe("closed");
});
