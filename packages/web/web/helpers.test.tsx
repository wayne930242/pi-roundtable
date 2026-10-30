import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	spyOn,
	test,
} from "bun:test";
import {
	type ArchivedEntry,
	type ConfigView,
	HELPERS_ENDED,
	type RoomMessage,
	type RoomView,
} from "../src/api-types.ts";
import { ActionMenuHost } from "./components/action-menu.tsx";
import { groupedEntries } from "./components/archive-list.tsx";
import { MessageRow } from "./components/message-row.tsx";
import { RoomConfirmHost } from "./components/room-confirms.tsx";
import { Toaster } from "./components/toaster.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { closeMenu, openMenu } from "./lib/action-menu.ts";
import { store } from "./lib/app-store.ts";
import { bulkApi } from "./lib/bulk-api.ts";
import { ConfigContext } from "./lib/config.ts";
import { reloadHelperFolds } from "./lib/helper-folds.ts";
import { loadKit } from "./lib/kit.ts";
import { roomMenuOf } from "./lib/menus.ts";
import { teamApi } from "./lib/team-api.ts";
import { RoomsPage } from "./pages/rooms.tsx";

const HOME = "app:agent.guide";
const SCOUT = "app:agent.scout";
const H1 = "app:agent.scout-1";
const H2 = "app:agent.scout-2";
const H3 = "app:agent.scout-3";

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

const helper = (
	key: string,
	over: Partial<RoomView> = {},
	finished = false,
): RoomView =>
	view(key, {
		muted: true,
		helper: {
			parent: SCOUT,
			parentName: "scout",
			...(finished ? { finished: true as const } : {}),
		},
		...over,
	});

let page: TestPage;
const spies: { mockRestore(): void }[] = [];
const track = <T extends { mockRestore(): void }>(spy: T): T => {
	spies.push(spy);
	return spy;
};
const stored = new Map<string, string>();

const settle = (ms = 40) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
const all = <T extends Element = HTMLElement>(selector: string): T[] => [
	...document.querySelectorAll<T>(selector),
];
const text = () => document.body.textContent ?? "";
async function shows(words: string): Promise<void> {
	for (let i = 0; i < 80 && !text().includes(words); i += 1) await settle(25);
	expect(text()).toContain(words);
}
const button = (label: string) =>
	all("button")
		.filter((one) => one.textContent === label)
		.at(-1) ?? null;
const menuItems = (): HTMLElement[] => all('[role^="menuitem"]');
const labels = () => menuItems().map((one) => one.textContent);

beforeAll(async () => {
	await loadKit();
	// The lazy chunks the list and its menus ask for load first, so no test waits on the clock.
	await import("./pages/thread-list.tsx");
	await import("./lib/menu-items.ts");
	await import("./lib/bulk-actions.ts");
	await import("./components/note-row.tsx");
	page = await openPage();
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
	window.innerWidth = 1280;
	stored.clear();
	reloadHelperFolds();
});
afterEach(async () => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	await page.act(() => closeMenu());
	for (const dismiss of all('.toaster [aria-label="Dismiss"]'))
		await page.click(dismiss);
	await page.render(null);
	store.dispatch({ type: "rooms_loaded", rooms: [], pins: [], folders: [] });
});

async function show(rooms: RoomView[]): Promise<void> {
	await page.render(
		<ConfigContext.Provider value={config}>
			<RoomsPage onSearch={() => undefined} />
			<ActionMenuHost />
			<RoomConfirmHost />
			<Toaster />
		</ConfigContext.Provider>,
	);
	await page.act(() => {
		store.dispatch({ type: "rooms_loaded", rooms, pins: [], folders: [] });
	});
	await page.act(() => settle(120));
}

/** Opens a room's menu as a long press does. */
async function openMenuOf(key: string): Promise<void> {
	const spec = await roomMenuOf(key);
	if (!spec) throw new Error(`no menu for ${key}`);
	await page.act(() => {
		openMenu({ ...spec, at: { x: 10, y: 10 }, via: "key", source: null });
	});
	await settle(60);
}
const choose = async (label: string) => {
	const item = menuItems().find((one) => one.textContent === label);
	if (!item) throw new Error(`no menu item ${label}: ${labels().join(", ")}`);
	await page.click(item);
	await settle(80);
};

const ROOMS = [view(HOME, { home: true }), view(SCOUT)];

test("a knight's temp knights hang under it, one row each with its state, and are no rooms of their own", async () => {
	await show([
		...ROOMS,
		helper(H1, { typing: true }),
		helper(H2, {}, true),
		helper(H3, {}, true),
	]);
	// With one at work the group is open.
	const rows = all("a.helper-link");
	expect(rows.map((one) => one.getAttribute("data-helper"))).toEqual([
		"scout-1",
		"scout-2",
		"scout-3",
	]);
	expect(rows[0]?.hasAttribute("data-finished")).toBe(false);
	expect(rows[0]?.querySelector(".helper-dot")).not.toBeNull();
	expect(rows[1]?.hasAttribute("data-finished")).toBe(true);
	expect(rows[1]?.textContent).toContain("Ended");
	expect(text()).toContain("3 temp knights");
	// The knights' own rows are the permanent ones only.
	expect(all("a.room-row")).toHaveLength(2);
});

test("a knight whose temp knights are all finished shows them folded, and a tap on the count opens them", async () => {
	await show([...ROOMS, helper(H1, {}, true), helper(H2, {}, true)]);
	expect(all("a.helper-link")).toHaveLength(0);
	expect(text()).toContain("2 temp knights");
	await page.click(button("2 temp knights"));
	await settle(40);
	expect(all("a.helper-link")).toHaveLength(2);
	// The choice is kept for this device.
	expect(stored.get("roundtable-console:helpers-folded")).toContain("false");
});

test("the list's menu clears the finished temp knights at once and Undo restores exactly those", async () => {
	const send = track(
		spyOn(bulkApi, "archiveFinishedHelpers"),
	).mockResolvedValue({
		archived: [{ room: SCOUT, names: ["scout-2", "scout-3"] }],
	});
	const back = track(spyOn(bulkApi, "restoreHelpers")).mockResolvedValue({
		restored: ["scout-2", "scout-3"],
	});
	await show([
		...ROOMS,
		helper(H1, { typing: true }),
		helper(H2, {}, true),
		helper(H3, {}, true),
	]);
	await page.click(document.querySelector('[aria-label="Folders and order"]'));
	await settle(60);
	await choose("Clear finished temp knights");
	// No confirmation stands between the item and the call.
	expect(send).toHaveBeenCalledTimes(1);
	expect(send.mock.calls[0]?.[0]).toBeUndefined();
	await shows("Archived 2 temp knights");
	await page.act(async () => {
		button("Undo")?.click();
		await settle(80);
	});
	expect(back).toHaveBeenCalledWith(["scout-2", "scout-3"]);
});

test("the item is left out of every menu while no temp knight has finished", async () => {
	await show([...ROOMS, helper(H1, { typing: true })]);
	await page.click(document.querySelector('[aria-label="Folders and order"]'));
	await settle(60);
	expect(labels()).not.toContain("Clear finished temp knights");
	await page.act(() => closeMenu());
	await openMenuOf(SCOUT);
	expect(labels()).not.toContain("Clear finished temp knights");
});

test("a knight's own menu clears its finished temp knights only, naming its room", async () => {
	const send = track(
		spyOn(bulkApi, "archiveFinishedHelpers"),
	).mockResolvedValue({ archived: [] });
	await show([...ROOMS, helper(H2, {}, true)]);
	await openMenuOf(SCOUT);
	expect(labels()).toContain("Clear finished temp knights");
	await choose("Clear finished temp knights");
	expect(send).toHaveBeenCalledWith([SCOUT]);
});

test("a temp knight's menu archives it at once with Undo, and offers no pin, folder or notification choice", async () => {
	const archive = track(spyOn(teamApi, "archiveAgent")).mockResolvedValue({
		ok: true,
	});
	const back = track(spyOn(bulkApi, "restoreHelpers")).mockResolvedValue({
		restored: ["scout-1"],
	});
	await show([...ROOMS, helper(H1, {}, true)]);
	await openMenuOf(H1);
	expect(labels()).toContain("Archive this temp knight");
	expect(labels()).not.toContain("Notifications");
	expect(labels()).not.toContain("Pin");
	await choose("Archive this temp knight");
	expect(archive).toHaveBeenCalledWith("scout-1");
	await shows("Archived scout-1");
	await page.act(async () => {
		button("Undo")?.click();
		await settle(80);
	});
	expect(back).toHaveBeenCalledWith(["scout-1"]);
});

const ended = (names: string[]): RoomMessage => ({
	id: 9,
	room: SCOUT,
	kind: "system",
	author: "Notice",
	text: `${HELPERS_ENDED}${JSON.stringify(names.map((name) => ({ name, displayName: `Name ${name}` })))}`,
	files: [],
	at: "2026-10-31T10:00:00.000Z",
});

const rowOf = (message: RoomMessage) => (
	<ConfigContext.Provider value={config}>
		<ul>
			<MessageRow
				message={message}
				character={undefined}
				header
				enter={false}
				timeZone="UTC"
				quotable
			/>
		</ul>
	</ConfigContext.Provider>
);

test("the knight's own clearing leaves a line in its room naming them, whose Undo restores exactly them", async () => {
	const back = track(spyOn(bulkApi, "restoreHelpers")).mockResolvedValue({
		restored: ["scout-1", "scout-2"],
	});
	store.dispatch({ type: "rooms_loaded", rooms: ROOMS });
	await page.render(rowOf(ended(["scout-1", "scout-2"])));
	await shows("scout archived 2 temp knights: Name scout-1, Name scout-2");
	await page.act(async () => {
		button("Undo")?.click();
		await settle(80);
	});
	expect(back).toHaveBeenCalledWith(["scout-1", "scout-2"]);
	expect((button("Undo") as HTMLButtonElement | null)?.disabled).toBe(true);
});

test("a message of an owner that starts like that line stays a message", async () => {
	await page.render(
		rowOf({
			...ended(["x"]),
			kind: "owner",
			author: "Owner",
			text: `${HELPERS_ENDED}[]`,
		}),
	);
	await settle(60);
	expect(all("li.message")).toHaveLength(1);
	expect(button("Undo")).toBeNull();
});

test("the archive page lists each temp knight right after its knight, and one whose knight is not archived last", () => {
	const entry = (name: string, parent?: string): ArchivedEntry => ({
		kind: "agent",
		name,
		displayName: name,
		...(parent ? { parent } : {}),
	});
	expect(
		groupedEntries([
			entry("b-1", "b"),
			entry("a"),
			entry("z-1", "z"),
			entry("a-1", "a"),
			entry("b"),
		]).map((one) => one.name),
	).toEqual(["a", "a-1", "b", "b-1", "z-1"]);
});
