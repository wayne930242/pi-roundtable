import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	spyOn,
	test,
} from "bun:test";
import type { ConfigView, LayoutView, RoomView } from "../src/api-types.ts";
import { ActionMenuHost } from "./components/action-menu.tsx";
import { FolderDialogHost } from "./components/folder-dialogs.tsx";
import { RoomConfirmHost } from "./components/room-confirms.tsx";
import { Toaster } from "./components/toaster.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { closeMenu } from "./lib/action-menu.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { bulkApi } from "./lib/bulk-api.ts";
import { ConfigContext } from "./lib/config.ts";
import { clearFolderDialog } from "./lib/folder-dialogs.ts";
import { reloadCollapsed } from "./lib/folds.ts";
import { seedUnread, totalUnread, unreadCounts } from "./lib/host-state.ts";
import { loadKit } from "./lib/kit.ts";
import { setRouting } from "./lib/router.ts";
import { RoomsPage } from "./pages/rooms.tsx";

const HOME = "app:agent.guide";
const SCOUT = "app:agent.scout";
const BUILD = "app:agent.build";
const F1 = "folder.00000000-0000-4000-8000-000000000001";
const T1 = "app:thread.0b5e7c1a-0000-4000-8000-000000000001";
const T2 = "app:thread.0b5e7c1a-0000-4000-8000-000000000002";
const T3 = "app:thread.0b5e7c1a-0000-4000-8000-000000000003";
const T4 = "app:thread.0b5e7c1a-0000-4000-8000-000000000004";

const config: ConfigView = {
	title: "Console",
	panes: ["rooms"],
	timeZone: "UTC",
	look: "modern",
};

const view = (key: string, over: Partial<RoomView> = {}): RoomView => ({
	key,
	kind: "agent",
	name: key.slice(key.indexOf(".") + 1),
	displayName: key.slice(key.indexOf(".") + 1),
	home: false,
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
	...over,
});

const thread = (
	key: string,
	parent: string,
	over: Partial<RoomView> = {},
): RoomView =>
	view(key, {
		kind: "thread",
		name: key.slice(key.indexOf(":") + 1),
		displayName: `Job ${key.slice(-1)}`,
		parent,
		readOnly: true,
		...over,
	});

let page: TestPage;
const spies: { mockRestore(): void }[] = [];
/** Remembers a spy so the next test starts with the real function. */
const track = <T extends { mockRestore(): void }>(spy: T): T => {
	spies.push(spy);
	return spy;
};
const stored = new Map<string, string>();
beforeAll(async () => {
	await loadKit();
	// The menus' actions load when first chosen; loading them now keeps that out of the first test.
	await import("./lib/bulk-actions.ts");
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
/** Zeroes every count: an earlier file's rooms may still hold some. */
const clearUnread = () =>
	seedUnread(
		Object.fromEntries(Object.keys(unreadCounts()).map((k) => [k, 0])),
	);
beforeEach(() => {
	window.innerWidth = 1280;
	stored.clear();
	reloadCollapsed();
	clearUnread();
});
afterEach(async () => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	await page.act(() => {
		closeMenu();
		clearFolderDialog();
	});
	// A notice left up would be the next test file's, here or elsewhere: they share the page's stores.
	for (const dismiss of all('.toaster [aria-label="Dismiss"]'))
		await page.click(dismiss);
	await page.render(null);
	store.dispatch({ type: "rooms_loaded", rooms: [], pins: [], folders: [] });
	// What the rooms carried is gone with them; the counts of other rooms are cleared by hand.
	clearUnread();
});

const settle = (ms = 40) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
/** The sorted rooms the first call of a spy asked for. */
const askedFor = (spy: { mock: { calls: unknown[][] } }): string[] =>
	[...((spy.mock.calls[0]?.[0] as string[] | undefined) ?? [])].sort();
const all = <T extends Element = HTMLElement>(selector: string): T[] => [
	...document.querySelectorAll<T>(selector),
];
const menuItems = (): HTMLElement[] => all('[role^="menuitem"]');
const labels = () => menuItems().map((one) => one.textContent);
const choose = async (label: string) => {
	const item = menuItems().find((one) => one.textContent === label);
	if (!item) throw new Error(`no menu item ${label}: ${labels().join(", ")}`);
	await page.click(item);
	await settle(80);
};
const text = () => document.body.textContent ?? "";
/** Waits for the words to be on the page: what a busy machine draws a moment late. */
async function shows(words: string): Promise<void> {
	for (let i = 0; i < 80 && !text().includes(words); i += 1) await settle(25);
	expect(text()).toContain(words);
}
/** The newest button of that name: notices of earlier tests may still be up. */
const button = (label: string) =>
	all("button")
		.filter((one) => one.textContent === label)
		.at(-1) ?? null;

async function show(
	rooms: RoomView[],
	layout: Partial<LayoutView> = {},
	unread: Record<string, number> = {},
): Promise<void> {
	await page.render(
		<ConfigContext.Provider value={config}>
			<RoomsPage onSearch={() => undefined} />
			<ActionMenuHost />
			<RoomConfirmHost />
			<FolderDialogHost />
			<Toaster />
		</ConfigContext.Provider>,
	);
	// Other files of the run leave a refusal or notices behind in the shared stores.
	await page.act(() => store.dispatch({ type: "refusal_dismissed" }));
	for (const dismiss of all('.toaster [aria-label="Dismiss"]'))
		await page.click(dismiss);
	await page.act(() => {
		store.dispatch({
			type: "rooms_loaded",
			rooms,
			pins: layout.pins ?? [],
			folders: layout.folders ?? [],
		});
		seedUnread(unread);
	});
	const want = layout.folders?.length ?? 0;
	for (let i = 0; i < 160 && all("[data-folder-block]").length < want; i += 1)
		await page.act(() => settle(25));
	await page.act(() => settle(80));
}

/** Opens the room list's own menu from its button. */
async function openPageMenu(): Promise<void> {
	await page.click(document.querySelector('[aria-label="Folders and order"]'));
	await settle(60);
}

const ROOMS = [view(HOME, { home: true }), view(SCOUT), view(BUILD)];

test("the list's menu marks everything read: it asks only for the rooms with something unread, clears the counts at once, and says how many", async () => {
	const send = track(spyOn(bulkApi, "readAll")).mockResolvedValue({
		moved: [
			{ room: SCOUT, from: 4, to: 9 },
			{ room: BUILD, from: 0, to: 3 },
		],
	});
	await show(ROOMS, {}, { [SCOUT]: 3, [BUILD]: 1 });
	expect(totalUnread()).toBe(4);
	await openPageMenu();
	expect(labels()).toEqual(["Mark all as read", "Add a folder", "Arrange"]);
	await choose("Mark all as read");
	expect(send).toHaveBeenCalledTimes(1);
	expect(askedFor(send)).toEqual([BUILD, SCOUT]);
	// The badges, the tab's count and so its dot are gone.
	expect(totalUnread()).toBe(0);
	expect(unreadCounts()).toEqual({});
	await shows("Marked 2 rooms as read");
});

test("the menu leaves the item out when nothing is unread", async () => {
	await show(ROOMS);
	await openPageMenu();
	expect(labels()).toEqual(["Add a folder", "Arrange"]);
});

test("Undo asks the server to put the cursors back, and the counts return", async () => {
	const moved = [{ room: SCOUT, from: 4, to: 9 }];
	track(spyOn(bulkApi, "readAll")).mockResolvedValue({ moved });
	const back = track(spyOn(bulkApi, "unreadAll")).mockResolvedValue({
		restored: [SCOUT],
	});
	await show(ROOMS, {}, { [SCOUT]: 3 });
	await openPageMenu();
	await choose("Mark all as read");
	await shows("Marked 1 room as read");
	expect(totalUnread()).toBe(0);
	await page.act(async () => {
		button("Undo")?.click();
		await settle(80);
	});
	expect(back).toHaveBeenCalledWith(moved);
	expect(unreadCounts()).toEqual({ [SCOUT]: 3 });
});

test("a refusal says why and leaves the counts as they were", async () => {
	track(spyOn(bulkApi, "readAll")).mockRejectedValue(new Error("Not today."));
	await show(ROOMS, {}, { [SCOUT]: 3 });
	await openPageMenu();
	await choose("Mark all as read");
	await shows("Not today.");
	expect(unreadCounts()).toEqual({ [SCOUT]: 3 });
});

test("a folder's menu marks only its own rooms and the threads under them", async () => {
	const send = track(spyOn(bulkApi, "readAll")).mockResolvedValue({
		moved: [],
	});
	await show(
		[...ROOMS, thread(T1, SCOUT, { closed: false })],
		{ folders: [{ id: F1, name: "Work", rooms: [SCOUT] }] },
		{ [SCOUT]: 2, [T1]: 5, [BUILD]: 7 },
	);
	await page.click(document.querySelector(".folder-more"));
	await settle(60);
	expect(labels()).toContain("Mark all as read");
	await choose("Mark all as read");
	expect(askedFor(send)).toEqual([SCOUT, T1]);
	// The room outside the folder keeps its count.
	expect(unreadCounts()).toEqual({ [BUILD]: 7 });
});

test("a folder whose rooms have nothing unread has no such item, even when other rooms do", async () => {
	await show(
		ROOMS,
		{ folders: [{ id: F1, name: "Work", rooms: [SCOUT] }] },
		{ [BUILD]: 7 },
	);
	await page.click(document.querySelector(".folder-more"));
	await settle(60);
	expect(labels()).not.toContain("Mark all as read");
});

const closedUnder = (...pairs: [string, string][]) =>
	pairs.map(([key, parent]) => thread(key, parent, { closed: true }));

test("the list's menu clears every finished thread under every room, a few at once, and Undo puts back exactly those", async () => {
	const send = track(spyOn(bulkApi, "dismissAllFinished")).mockResolvedValue({
		dismissed: 3,
		threads: { [HOME]: [T1, T2], [SCOUT]: [T3] },
	});
	const back = track(spyOn(api, "undismissThreads")).mockResolvedValue({
		restored: 1,
	});
	await show([
		...ROOMS,
		...closedUnder([T1, HOME], [T2, HOME], [T3, SCOUT]),
		thread(T4, SCOUT, { closed: false }),
	]);
	await openPageMenu();
	expect(labels()).toEqual([
		"Clear all finished threads",
		"Add a folder",
		"Arrange",
	]);
	await choose("Clear all finished threads");
	expect(send).toHaveBeenCalledTimes(1);
	expect(askedFor(send)).toEqual([HOME, SCOUT].sort());
	expect(store.getState().order).toEqual([HOME, SCOUT, BUILD, T4]);
	await shows("Cleared 3 finished threads");
	await page.act(async () => {
		button("Undo")?.click();
		await settle(80);
	});
	expect(back).toHaveBeenCalledTimes(2);
	expect(back).toHaveBeenCalledWith(HOME, [T1, T2]);
	expect(back).toHaveBeenCalledWith(SCOUT, [T3]);
});

test("a thread that is still open is never offered for clearing", async () => {
	await show([...ROOMS, thread(T4, SCOUT, { closed: false })]);
	await openPageMenu();
	expect(labels()).toEqual(["Add a folder", "Arrange"]);
});

test("clearing more than five finished threads goes ahead at once, with no question", async () => {
	const keys = Array.from(
		{ length: 6 },
		(_, i) => `app:thread.0b5e7c1a-0000-4000-8000-0000000002${i}0`,
	);
	const send = track(spyOn(bulkApi, "dismissAllFinished")).mockResolvedValue({
		dismissed: 6,
		threads: { [HOME]: keys },
	});
	await show([
		...ROOMS,
		...keys.map((key) => thread(key, HOME, { closed: true })),
	]);
	await openPageMenu();
	await choose("Clear all finished threads");
	expect(send).toHaveBeenCalledWith([HOME]);
	expect(text()).not.toContain("finished threads?");
	expect(store.getState().order).toEqual([HOME, SCOUT, BUILD]);
	await shows("Cleared 6 finished threads");
});

test("a folder's menu clears the finished threads of its own rooms only", async () => {
	const send = track(spyOn(bulkApi, "dismissAllFinished")).mockResolvedValue({
		dismissed: 1,
		threads: { [SCOUT]: [T3] },
	});
	await show([...ROOMS, ...closedUnder([T1, HOME], [T3, SCOUT])], {
		folders: [{ id: F1, name: "Work", rooms: [SCOUT] }],
	});
	await page.click(document.querySelector(".folder-more"));
	await settle(60);
	expect(labels()).toContain("Clear all finished threads");
	await choose("Clear all finished threads");
	expect(send).toHaveBeenCalledWith([SCOUT]);
	// The thread of a room outside the folder stays.
	expect(store.getState().order).toContain(T1);
	expect(store.getState().order).not.toContain(T3);
});
