import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	spyOn,
	test,
} from "bun:test";
import { partial } from "pi-roundtable/testing";
import type { ClientFrame, ConfigView, RoomView } from "../src/api-types.ts";
import { ActionMenuHost } from "./components/action-menu.tsx";
import { GroupTable } from "./components/group-table.tsx";
import { Toaster } from "./components/toaster.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { closeMenu } from "./lib/action-menu.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { clearDrafts } from "./lib/drafts.ts";
import { loadKit } from "./lib/kit.ts";
import { setLook } from "./lib/look.ts";
import { setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import { TablePage } from "./pages/table.tsx";

const config: ConfigView = {
	title: "Console",
	panes: ["table"],
	timeZone: "UTC",
	look: "modern",
};

const keyOf = (name: string) => `app:agent.${name}`;

const agent = (name: string, over: Partial<RoomView> = {}): RoomView => ({
	key: keyOf(name),
	kind: "agent",
	name,
	displayName: name,
	home: false,
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
	...over,
});

const load = (rooms: RoomView[]) =>
	store.dispatch({ type: "rooms_loaded", rooms });

let page: TestPage;
let setMute: ReturnType<typeof spyOn>;
const realMatchMedia = globalThis.matchMedia;

beforeAll(async () => {
	await loadKit();
	page = await openPage();
	setRouting(undefined);
	window.matchMedia = ((query: string) => ({
		matches: false,
		media: query,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		addListener: () => undefined,
		removeListener: () => undefined,
		dispatchEvent: () => false,
		onchange: null,
	})) as typeof window.matchMedia;
});
afterAll(async () => {
	window.matchMedia = realMatchMedia;
	setConnection(undefined);
	await page.unmount();
	await releaseDom();
});

beforeEach(() => {
	setConnection(
		partial<AppConnection>({
			send: (_frame: ClientFrame) => true,
			focus: (room?: string) => store.dispatch({ type: "focused", room }),
			say: () => undefined,
		}),
	);
	window.innerWidth = 1280;
	window.location.hash = "#/table";
	load([agent("lena"), agent("otto"), agent("nova")]);
	// the server's answer: the room is muted as asked
	setMute = spyOn(api, "setMute").mockImplementation(async (_room, muted) => ({
		muted,
	}));
	spyOn(api, "messages").mockImplementation(async () => ({
		messages: [],
		more: false,
		cards: [],
	}));
});
afterEach(async () => {
	await page.act(() => closeMenu());
	await page.render(null);
	setMute.mockRestore();
	load([]);
	clearDrafts();
	setLook(undefined);
});

const settle = (ms = 80) =>
	page.act(() => new Promise((done) => setTimeout(done, ms)));
const q = <T extends Element = HTMLElement>(selector: string): T | null =>
	document.querySelector<T>(selector);
const all = <T extends Element = HTMLElement>(selector: string): T[] => [
	...document.querySelectorAll<T>(selector),
];
/** The names of the agents who sit, as the scene labels them. */
const seated = () =>
	all("g.seat").map((seat) => seat.getAttribute("aria-label")?.split(" ")[0]);

const render = (focus?: string) =>
	page.render(
		<ConfigContext.Provider value={config}>
			<TablePage focus={focus} />
			<ActionMenuHost />
			<Toaster />
		</ConfigContext.Provider>,
	);

const openSheet = async () => {
	const button = all("button").find((one) =>
		one.textContent?.includes("Who's at the table"),
	);
	if (!button) throw new Error("no Who's at the table button");
	await page.click(button);
	await settle(120);
};
const switches = () =>
	all<HTMLButtonElement>("dialog.sheet [role=switch]").map((one) => ({
		name: one.getAttribute("aria-label"),
		on: one.getAttribute("aria-checked") === "true",
	}));
const flip = async (name: string) => {
	const toggle = all<HTMLButtonElement>("dialog.sheet [role=switch]").find(
		(one) => one.getAttribute("aria-label") === name,
	);
	if (!toggle) throw new Error(`no switch for ${name}`);
	await page.click(toggle);
	await settle(40);
};
const menuItems = () => all('[role^="menuitem"]').map((one) => one.textContent);
const choose = async (label: string) => {
	const item = all('[role^="menuitem"]').find(
		(one) => one.textContent === label,
	);
	if (!item)
		throw new Error(`no menu item ${label}: ${menuItems().join(", ")}`);
	await page.click(item);
	await settle(80);
};
const rightClickSeat = (name: string) =>
	page.act(async () => {
		const seat = q(`g.seat[aria-label^="${name} "]`);
		if (!seat) throw new Error(`no seat for ${name}`);
		seat.dispatchEvent(
			new MouseEvent("contextmenu", {
				bubbles: true,
				cancelable: true,
				clientX: 200,
				clientY: 120,
			}),
		);
		await new Promise((done) => setTimeout(done, 40));
	});

test("the table seats exactly the agents whose room is not muted", async () => {
	load([agent("lena"), agent("otto", { muted: true }), agent("nova")]);
	await render();
	await settle();
	expect(seated().sort()).toEqual(["lena", "nova"]);
});

test("muting a room anywhere takes its agent off the table, and unmuting seats it again", async () => {
	await render();
	await settle();
	expect(seated()).toHaveLength(3);
	await page.act(() =>
		store.dispatch({ type: "room_muted", room: keyOf("otto"), muted: true }),
	);
	await settle();
	expect(seated().sort()).toEqual(["lena", "nova"]);
	await page.act(() =>
		store.dispatch({ type: "room_muted", room: keyOf("otto"), muted: false }),
	);
	await settle();
	expect(seated().sort()).toEqual(["lena", "nova", "otto"]);
});

test("Who's at the table opens a sheet that lists every agent with a switch: on for those who sit", async () => {
	load([agent("lena"), agent("otto", { muted: true }), agent("nova")]);
	await render();
	await settle();
	expect(q("dialog.sheet[open]")).toBeNull();
	await openSheet();
	expect(switches()).toEqual([
		{ name: "lena", on: true },
		{ name: "otto", on: false },
		{ name: "nova", on: true },
	]);
	// each row carries the agent's picture and name
	const rows = all("dialog.sheet .seat-row");
	expect(rows).toHaveLength(3);
	expect(rows[1]?.textContent).toContain("otto");
	expect(rows[1]?.querySelector("svg")).not.toBeNull();
});

test("switching an agent off mutes its room for every owner and the scene re-seats at once; switching it on unmutes", async () => {
	await render();
	await settle();
	await openSheet();
	await flip("otto");
	expect(setMute).toHaveBeenCalledWith(keyOf("otto"), true);
	expect(store.getState().rooms[keyOf("otto")]?.view?.muted).toBe(true);
	expect(switches().find((one) => one.name === "otto")?.on).toBe(false);
	await settle();
	expect(seated().sort()).toEqual(["lena", "nova"]);
	await flip("otto");
	expect(setMute).toHaveBeenLastCalledWith(keyOf("otto"), false);
	await settle();
	expect(seated().sort()).toEqual(["lena", "nova", "otto"]);
});

test("a refused mute leaves the agent at the table and the switch on", async () => {
	setMute.mockImplementation(async () => {
		throw new Error("Only an owner can do that.");
	});
	await render();
	await settle();
	await openSheet();
	await flip("otto");
	expect(switches().find((one) => one.name === "otto")?.on).toBe(true);
	expect(seated()).toHaveLength(3);
});

test("a muted room is reached from the rooms list: the sheet only changes the mute, never removes the room", async () => {
	await render();
	await settle();
	await openSheet();
	await flip("lena");
	expect(store.getState().rooms[keyOf("lena")]?.view).toBeDefined();
	expect(store.getState().order).toContain(keyOf("lena"));
});

test("a seat's menu offers to leave the table, and choosing it mutes the room", async () => {
	await render();
	await settle();
	await rightClickSeat("otto");
	expect(menuItems()).toEqual(["Leave the table"]);
	await choose("Leave the table");
	expect(setMute).toHaveBeenCalledWith(keyOf("otto"), true);
	await settle();
	expect(seated().sort()).toEqual(["lena", "nova"]);
});

test("the dialogue box's menu offers the same, and an agent that leaves while the camera is on it sends the table back to the whole ring in place", async () => {
	window.location.hash = "#/table/otto";
	const before = window.history.length;
	await render("otto");
	await settle();
	expect(q(".scene-box")).not.toBeNull();
	const more = q<HTMLButtonElement>('.scene-box button[aria-label="More"]');
	expect(more).not.toBeNull();
	await page.act(async () => {
		more?.click();
		await new Promise((done) => setTimeout(done, 40));
	});
	expect(menuItems()).toEqual(["Leave the table"]);
	await choose("Leave the table");
	expect(setMute).toHaveBeenCalledWith(keyOf("otto"), true);
	await settle();
	expect(q(".scene-box")).toBeNull();
	expect(window.location.hash).toBe("#/table");
	expect(window.history.length).toBe(before);
	expect(seated().sort()).toEqual(["lena", "nova"]);
});

test("an address that names an agent who is off the table goes back to the whole ring", async () => {
	load([agent("lena"), agent("otto", { muted: true }), agent("nova")]);
	window.location.hash = "#/table/otto";
	await render("otto");
	await settle();
	expect(window.location.hash).toBe("#/table");
	expect(q(".scene-box")).toBeNull();
});

test("the camera stays on an agent who stays when another leaves", async () => {
	window.location.hash = "#/table/lena";
	await render("lena");
	await settle();
	await page.act(() =>
		store.dispatch({ type: "room_muted", room: keyOf("nova"), muted: true }),
	);
	await settle();
	expect(window.location.hash).toBe("#/table/lena");
	expect(q(".scene-box .scene-name")?.textContent).toBe("lena");
	expect(seated().sort()).toEqual(["lena", "otto"]);
});

test("with everyone off the table the page says so and offers Who's at the table", async () => {
	load([
		agent("lena", { muted: true }),
		agent("otto", { muted: true }),
		agent("nova", { muted: true }),
	]);
	await render();
	await settle();
	expect(q(".table-empty-state")).not.toBeNull();
	expect(q(".table-host")).toBeNull();
	expect(q(".table-empty-state")?.textContent).toContain("The table is empty");
	const button = q<HTMLButtonElement>(".table-empty-state button");
	expect(button?.textContent).toContain("Who's at the table");
	await page.click(button);
	await settle(120);
	expect(switches().map((one) => one.on)).toEqual([false, false, false]);
	// the first one back sits down and the empty state gives way to the table
	await flip("nova");
	await settle();
	expect(q(".table-empty-state")).toBeNull();
	expect(seated()).toEqual(["nova"]);
});

test("a page with no agents at all keeps its plain message and has nothing to choose", async () => {
	load([]);
	await render();
	await settle();
	expect(q(".table-empty")).not.toBeNull();
	expect(q(".table-empty-state")).toBeNull();
	expect(
		all("button").some((one) =>
			one.textContent?.includes("Who's at the table"),
		),
	).toBe(false);
});

test("a group room's table still seats its muted members", async () => {
	setLook("camelot");
	load([
		agent("lena"),
		agent("otto", { muted: true }),
		agent("nova"),
		{
			key: "app:group.crew",
			kind: "group",
			name: "crew",
			displayName: "Crew",
			home: false,
			readOnly: false,
			members: ["lena", "otto"],
			mode: { yolo: false, longRunning: false },
			typing: false,
			stoppable: false,
		},
	]);
	await page.render(
		<GroupTable
			roomKey="app:group.crew"
			scene={false}
			onScene={() => undefined}
		/>,
	);
	await settle();
	expect(seated().sort()).toEqual(["lena", "otto"]);
});
