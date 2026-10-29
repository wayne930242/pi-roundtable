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
import type {
	ConfigView,
	LayoutView,
	PromptFrame,
	RoomView,
} from "../src/api-types.ts";
import { ActionMenuHost } from "./components/action-menu.tsx";
import { FolderDialogHost } from "./components/folder-dialogs.tsx";
import { RoomConfirmHost } from "./components/room-confirms.tsx";
import { Toaster } from "./components/toaster.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { closeMenu } from "./lib/action-menu.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { clearFolderDialog } from "./lib/folder-dialogs.ts";
import { loadKit } from "./lib/kit.ts";
import { COLLAPSED_KEY, reloadCollapsed } from "./lib/layout.ts";
import { setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import { RoomsPage } from "./pages/rooms.tsx";

const HOME = "app:agent.guide";
const SCOUT = "app:agent.scout";
const BUILD = "app:agent.build";
const TEAM = "app:group.team";
const F1 = "folder.00000000-0000-4000-8000-000000000001";
const F2 = "folder.00000000-0000-4000-8000-000000000002";

const config: ConfigView = {
	title: "Console",
	panes: ["rooms"],
	timeZone: "UTC",
	look: "modern",
};

const view = (key: string, over: Partial<RoomView> = {}): RoomView => ({
	key,
	kind: key.includes(":group.") ? "group" : "agent",
	name: key.slice(key.indexOf(".") + 1),
	displayName: key.slice(key.indexOf(".") + 1),
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
	view(TEAM, { members: ["scout"] }),
];

const load = (layout: Partial<LayoutView> = {}) =>
	store.dispatch({
		type: "rooms_loaded",
		rooms: ROOMS,
		pins: layout.pins ?? [],
		folders: layout.folders ?? [],
	});

const stored = new Map<string, string>();
let page: TestPage;
beforeAll(async () => {
	await loadKit();
	page = await openPage();
	setRouting(undefined);
	setConnection(partial<AppConnection>({ send: () => true }));
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
	setConnection(undefined);
	await page.unmount();
	await releaseDom();
});

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits for something that needs a hold and a lazy chunk, which a busy machine takes longer over. */
async function until(done: () => boolean, ms = 4000): Promise<void> {
	const stop = Date.now() + ms;
	while (!done() && Date.now() < stop) await settle(25);
}

beforeEach(() => {
	window.innerWidth = 1280;
	stored.clear();
	reloadCollapsed();
	load();
});
afterEach(async () => {
	await page.act(() => {
		closeMenu();
		clearFolderDialog();
	});
	await page.render(null);
	store.dispatch({ type: "rooms_loaded", rooms: [], pins: [], folders: [] });
});

const q = <T extends Element = HTMLElement>(selector: string): T | null =>
	document.querySelector<T>(selector);
const all = <T extends Element = HTMLElement>(selector: string): T[] => [
	...document.querySelectorAll<T>(selector),
];
const rowOf = (name: string) =>
	all(".room-row").find((one) => one.textContent?.includes(name)) ?? null;
const headings = () =>
	all(".section-title, .folder-head strong").map((one) => one.textContent);
const rightClick = (target: Element | null) => {
	if (!target) throw new Error("nothing to click");
	return page.act(async () => {
		target.dispatchEvent(
			new MouseEvent("contextmenu", {
				bubbles: true,
				cancelable: true,
				clientX: 120,
				clientY: 80,
			}),
		);
		await settle(30);
	});
};
const menuItems = (): HTMLElement[] => all('[role^="menuitem"]');
const labels = () => menuItems().map((one) => one.textContent);
const choose = async (label: string) => {
	const item = menuItems().find((one) => one.textContent === label);
	if (!item) throw new Error(`no menu item ${label}: ${labels().join(", ")}`);
	await page.click(item);
	await settle(80);
};
const typeInto = (element: HTMLInputElement | null, text: string) => {
	if (!element) throw new Error("nothing to type into");
	return page.act(() => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(element, text);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
};
const dialog = (title: string) =>
	all<HTMLDialogElement>("dialog").find(
		(one) => one.open && one.getAttribute("aria-label") === title,
	);

const List = (props: { active?: string }) => (
	<ConfigContext.Provider value={config}>
		<RoomsPage onSearch={() => undefined} active={props.active} />
		<ActionMenuHost />
		<RoomConfirmHost />
		<FolderDialogHost />
		<Toaster />
	</ConfigContext.Provider>
);

const WORK = { id: F1, name: "Work", rooms: [SCOUT] };

test("with no pin and no folder the page is as it was: Home, Agents, Groups, no folder controls", async () => {
	await page.render(<List />);
	expect(headings()).toEqual(["Home", "Agents", "Groups"]);
	expect(all(".folder")).toEqual([]);
	// Normal mode: no menu button beside a row, no arrange bar.
	expect(all(".row-more")).toEqual([]);
	expect(q(".arrange-bar")).toBeNull();
});

test("Home leads, then the pinned rooms, the folders in order, and the rest as Ungrouped", async () => {
	load({
		pins: [BUILD],
		folders: [WORK, { id: F2, name: "Play", rooms: [] }],
	});
	await page.render(<List />);
	expect(headings()).toEqual(["Home", "Pinned", "Work", "Play", "Ungrouped"]);
	const names = all(".room-row strong").map((one) => one.textContent);
	expect(names).toEqual(["guide", "build", "scout", "team"]);
	// An empty folder says so.
	expect(q(`[data-folder="${F2}"] .folder-empty`)?.textContent).toBe(
		"No rooms in this folder yet.",
	);
	// A deleted agent's key in the layout shows nothing.
	load({ pins: ["app:agent.deleted", BUILD] });
	await page.render(<List />);
	expect(all(".room-row strong").map((one) => one.textContent)).toEqual([
		"guide",
		"build",
		"scout",
		"team",
	]);
});

test("a folder's header folds it, keeps the fold on this device, and counts its rooms", async () => {
	load({ folders: [WORK] });
	await page.render(<List />);
	const toggle = q<HTMLButtonElement>(".folder-toggle");
	expect(toggle?.getAttribute("aria-expanded")).toBe("true");
	expect(toggle?.textContent).toContain("1 room");
	expect(q(".folder-body")?.hasAttribute("hidden")).toBe(false);
	await page.click(toggle);
	expect(toggle?.getAttribute("aria-expanded")).toBe("false");
	expect(q(".folder-body")?.hasAttribute("hidden")).toBe(true);
	expect(toggle?.getAttribute("aria-controls")).toBe(q(".folder-body")?.id);
	expect(JSON.parse(stored.get(COLLAPSED_KEY) ?? "[]")).toEqual([F1]);
	await page.click(toggle);
	expect(toggle?.getAttribute("aria-expanded")).toBe("true");
	expect(JSON.parse(stored.get(COLLAPSED_KEY) ?? "[]")).toEqual([]);
});

test("the folder that holds the open room shows open while its stored fold stays", async () => {
	load({ folders: [WORK] });
	stored.set(COLLAPSED_KEY, JSON.stringify([F1]));
	reloadCollapsed();
	await page.render(<List active={SCOUT} />);
	expect(q(".folder-toggle")?.getAttribute("aria-expanded")).toBe("true");
	expect(JSON.parse(stored.get(COLLAPSED_KEY) ?? "[]")).toEqual([F1]);
	await page.render(<List active={BUILD} />);
	expect(q(".folder-toggle")?.getAttribute("aria-expanded")).toBe("false");
});

test("a folded folder still shows a waiting card and the working dots of its rooms", async () => {
	load({ folders: [WORK] });
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
		room: SCOUT,
		typing: true,
		stoppable: true,
	});
	await page.render(<List />);
	const head = q(".folder-head")?.textContent ?? "";
	expect(head).toContain("1 card waiting");
	expect(q(".folder-head .typing")).not.toBeNull();
	// Open, the rooms say it themselves.
	await page.click(q(".folder-toggle"));
	expect(q(".folder-head .typing")).toBeNull();
	store.dispatch({ type: "prompt_closed", prompt: "p1", outcome: "approved" });
});

test("a folder shows a bell-slash when all its rooms are muted and a fainter one when some are", async () => {
	load({ folders: [{ id: F1, name: "Work", rooms: [SCOUT, BUILD] }] });
	await page.render(<List />);
	expect(q(".folder-head .muted-mark")).toBeNull();
	store.dispatch({ type: "room_muted", room: SCOUT, muted: true });
	await page.render(<List />);
	const some = q(".folder-head .muted-mark");
	expect(some?.getAttribute("aria-label")).toBe("Some notifications are off");
	expect(some?.hasAttribute("data-partial")).toBe(true);
	store.dispatch({ type: "room_muted", room: BUILD, muted: true });
	await page.render(<List />);
	const every = q(".folder-head .muted-mark");
	expect(every?.getAttribute("aria-label")).toBe("Notifications are off");
	expect(every?.hasAttribute("data-partial")).toBe(false);
});

test("the folder menu renames, mutes, steps and deletes; the ends have no step", async () => {
	load({
		folders: [WORK, { id: F2, name: "Play", rooms: [BUILD] }],
	});
	await page.render(<List />);
	await rightClick(q(`[data-folder="${F1}"] .folder-head`));
	expect(labels()).toEqual([
		"Rename",
		"Mute the whole folder",
		"Move down",
		"Delete folder",
	]);
	await page.act(() => closeMenu());
	await rightClick(q(`[data-folder="${F2}"] .folder-head`));
	expect(labels()).toEqual([
		"Rename",
		"Mute the whole folder",
		"Move up",
		"Delete folder",
	]);
});

test("muting a whole folder asks the server once and shows the bells at once; unmuting reverses it", async () => {
	load({ folders: [{ id: F1, name: "Work", rooms: [SCOUT, TEAM] }] });
	const mute = spyOn(api, "muteFolder").mockResolvedValue({
		muted: true,
		rooms: [SCOUT, TEAM],
	});
	try {
		await page.render(<List />);
		await rightClick(q(".folder-head"));
		await choose("Mute the whole folder");
		expect(mute).toHaveBeenCalledWith(F1, true);
		expect(store.getState().rooms[SCOUT]?.view?.muted).toBe(true);
		expect(store.getState().rooms[TEAM]?.view?.muted).toBe(true);
		mute.mockResolvedValue({ muted: false, rooms: [SCOUT, TEAM] });
		await rightClick(q(".folder-head"));
		expect(labels()).toContain("Unmute the whole folder");
		await choose("Unmute the whole folder");
		expect(mute).toHaveBeenLastCalledWith(F1, false);
		expect(store.getState().rooms[SCOUT]?.view?.muted).toBeUndefined();
	} finally {
		mute.mockRestore();
	}
});

test("deleting a folder asks first, with the words of the spec, and then deletes it", async () => {
	load({ folders: [WORK] });
	const remove = spyOn(api, "deleteFolder").mockResolvedValue({
		pins: [],
		folders: [],
	});
	try {
		await page.render(<List />);
		await rightClick(q(".folder-head"));
		await choose("Delete folder");
		expect(remove).not.toHaveBeenCalled();
		const ask = dialog("Delete folder");
		expect(ask?.textContent).toContain(
			"Delete the folder Work? Its rooms move to Ungrouped; no room is deleted.",
		);
		const confirm = [...(ask?.querySelectorAll("button") ?? [])].find(
			(one) => one.textContent === "Delete folder",
		);
		await page.click(confirm ?? null);
		expect(remove).toHaveBeenCalledWith(F1);
		expect(store.getState().folders).toEqual([]);
	} finally {
		remove.mockRestore();
	}
});

test("renaming shows the folder's name, refuses an empty one before asking the server, and sends the new one", async () => {
	load({ folders: [WORK] });
	const change = spyOn(api, "changeFolder").mockResolvedValue({
		pins: [],
		folders: [{ ...WORK, name: "Office" }],
	});
	try {
		await page.render(<List />);
		await rightClick(q(".folder-head"));
		await choose("Rename");
		const form = dialog("Rename folder");
		const input = form?.querySelector<HTMLInputElement>("input") ?? null;
		expect(input?.value).toBe("Work");
		await typeInto(input, "   ");
		await page.click(
			[...(form?.querySelectorAll("button") ?? [])].find(
				(one) => one.textContent === "Rename",
			) ?? null,
		);
		expect(change).not.toHaveBeenCalled();
		expect(form?.textContent).toContain(
			"Give the folder a name of 1 to 40 characters.",
		);
		await typeInto(input, "Office");
		await page.click(
			[...(form?.querySelectorAll("button") ?? [])].find(
				(one) => one.textContent === "Rename",
			) ?? null,
		);
		expect(change).toHaveBeenCalledWith(F1, { name: "Office" });
		expect(store.getState().folders[0]?.name).toBe("Office");
	} finally {
		change.mockRestore();
	}
});

test("the page's menu adds a folder outside arrange mode, and shows the server's refusal inside the dialog", async () => {
	const create = spyOn(api, "createFolder").mockRejectedValue(
		new Error("A folder of that name exists."),
	);
	try {
		await page.render(<List />);
		await page.click(q('[aria-label="Folders and order"]'));
		await settle(40);
		await choose("Add a folder");
		const form = dialog("Add a folder");
		await typeInto(
			form?.querySelector<HTMLInputElement>("input") ?? null,
			"Play",
		);
		await page.click(
			[...(form?.querySelectorAll("button") ?? [])].find(
				(one) => one.textContent === "Create",
			) ?? null,
		);
		expect(create).toHaveBeenCalledWith("Play");
		expect(form?.textContent).toContain("A folder of that name exists.");
		create.mockResolvedValue({
			pins: [],
			folders: [{ id: F2, name: "Play", rooms: [] }],
		});
		await page.click(
			[...(form?.querySelectorAll("button") ?? [])].find(
				(one) => one.textContent === "Create",
			) ?? null,
		);
		expect(store.getState().folders.map((f) => f.name)).toEqual(["Play"]);
		expect(headings()).toContain("Play");
	} finally {
		create.mockRestore();
	}
});

test("arrange mode shows a menu button on each row and a bar to add a folder; Done takes them away", async () => {
	await page.render(<List />);
	await page.click(q('[aria-label="Folders and order"]'));
	await settle(40);
	await choose("Arrange");
	expect(all(".row-more").length).toBe(4);
	expect(q(".arrange-bar")?.textContent).toContain("Add a folder");
	await page.click(
		all("button").find((one) => one.textContent === "Done") ?? null,
	);
	expect(all(".row-more")).toEqual([]);
	expect(q(".arrange-bar")).toBeNull();
});

test("a row's menu pins and unpins it, and the list follows the server's answer", async () => {
	const pin = spyOn(api, "pinRoom").mockResolvedValue({
		pins: [SCOUT],
		folders: [],
	});
	try {
		await page.render(<List />);
		await rightClick(rowOf("scout"));
		expect(labels().slice(0, 2)).toEqual(["Pin", "Move to folder…"]);
		await choose("Pin");
		expect(pin).toHaveBeenCalledWith(SCOUT, true, null);
		expect(headings()).toEqual(["Home", "Pinned", "Agents", "Groups"]);
		pin.mockResolvedValue({ pins: [], folders: [] });
		await rightClick(rowOf("scout"));
		expect(labels().slice(0, 2)).toEqual(["Unpin", "Move to folder…"]);
		await choose("Unpin");
		expect(pin).toHaveBeenLastCalledWith(SCOUT, false, null);
		expect(headings()).toEqual(["Home", "Agents", "Groups"]);
	} finally {
		pin.mockRestore();
	}
});

test("Home has no pin and no folder in its menu; a pinned room can step up and down", async () => {
	load({ pins: [SCOUT, BUILD, TEAM] });
	await page.render(<List />);
	await rightClick(rowOf("guide"));
	expect(labels()).not.toContain("Pin");
	expect(labels()).not.toContain("Move to folder…");
	await page.act(() => closeMenu());
	await rightClick(rowOf("scout"));
	expect(labels().slice(0, 3)).toEqual([
		"Unpin",
		"Move to folder…",
		"Move down",
	]);
	await page.act(() => closeMenu());
	await rightClick(rowOf("build"));
	expect(labels().slice(0, 4)).toEqual([
		"Unpin",
		"Move to folder…",
		"Move up",
		"Move down",
	]);
	await page.act(() => closeMenu());
	const place = spyOn(api, "pinRoom").mockResolvedValue({
		pins: [BUILD, SCOUT, TEAM],
		folders: [],
	});
	try {
		await rightClick(rowOf("build"));
		await choose("Move up");
		expect(place).toHaveBeenCalledWith(BUILD, true, SCOUT);
		expect(all(".room-row strong").map((one) => one.textContent)).toEqual([
			"guide",
			"build",
			"scout",
			"team",
		]);
	} finally {
		place.mockRestore();
	}
});

test("Move to folder lists the folders and Ungrouped, marks where the room is, and moves it", async () => {
	load({ folders: [WORK, { id: F2, name: "Play", rooms: [] }] });
	const place = spyOn(api, "placeRoom").mockResolvedValue({
		pins: [],
		folders: [
			{ ...WORK, rooms: [] },
			{ id: F2, name: "Play", rooms: [SCOUT] },
		],
	});
	try {
		await page.render(<List />);
		await rightClick(rowOf("scout"));
		await choose("Move to folder…");
		const sheet = dialog("Move to folder…");
		const radios = [
			...(sheet?.querySelectorAll<HTMLInputElement>("input[type=radio]") ?? []),
		];
		expect(radios.map((one) => one.closest("label")?.textContent)).toEqual([
			"Ungrouped",
			"Work",
			"Play",
		]);
		expect(radios.map((one) => one.checked)).toEqual([false, true, false]);
		await page.click(radios[2] ?? null);
		await settle(40);
		expect(place).toHaveBeenCalledWith(SCOUT, F2, null);
		expect(store.getState().folders[1]?.rooms).toEqual([SCOUT]);
	} finally {
		place.mockRestore();
	}
});

test("Move to folder can add a folder first and then moves the room into it", async () => {
	const create = spyOn(api, "createFolder").mockResolvedValue({
		pins: [],
		folders: [{ id: F2, name: "Play", rooms: [] }],
	});
	const place = spyOn(api, "placeRoom").mockResolvedValue({
		pins: [],
		folders: [{ id: F2, name: "Play", rooms: [BUILD] }],
	});
	try {
		await page.render(<List />);
		await rightClick(rowOf("build"));
		await choose("Move to folder…");
		await page.click(
			all("button").find((one) => one.textContent === "New folder…") ?? null,
		);
		await settle(40);
		const form = dialog("Add a folder");
		await typeInto(
			form?.querySelector<HTMLInputElement>("input") ?? null,
			"Play",
		);
		await page.click(
			[...(form?.querySelectorAll("button") ?? [])].find(
				(one) => one.textContent === "Create",
			) ?? null,
		);
		await settle(40);
		expect(create).toHaveBeenCalledWith("Play");
		expect(place).toHaveBeenCalledWith(BUILD, F2, null);
		expect(store.getState().folders[0]?.rooms).toEqual([BUILD]);
	} finally {
		create.mockRestore();
		place.mockRestore();
	}
});

test("a row can be lifted: it and its folder block carry what the drag looks for", async () => {
	load({ pins: [BUILD], folders: [WORK] });
	await page.render(<List />);
	const row = rowOf("scout")?.closest("li");
	expect(row?.getAttribute("data-drop-item")).toBe("");
	expect(row?.getAttribute("data-key")).toBe(SCOUT);
	expect(row?.closest("[data-drop-zone]")?.getAttribute("data-folder")).toBe(
		F1,
	);
	expect(
		rowOf("build")?.closest("[data-drop-zone]")?.getAttribute("data-drop-zone"),
	).toBe("pinned");
	expect(
		rowOf("team")?.closest("[data-drop-zone]")?.getAttribute("data-drop-zone"),
	).toBe("rest");
	// Home cannot be lifted or dropped on.
	expect(rowOf("guide")?.closest("li")?.hasAttribute("data-drop-item")).toBe(
		false,
	);
	expect(q("[data-folder-block]")?.getAttribute("data-key")).toBe(F1);
	expect(q("[data-drop-root]")).not.toBeNull();
});

// ── Lifting a row with a finger or a mouse ───────────────────────────────────────────────────

function pointer(
	target: Element,
	type: "pointerdown" | "pointermove" | "pointerup",
	over: {
		x?: number;
		y?: number;
		kind?: "touch" | "mouse";
		buttons?: number;
	} = {},
): void {
	const event = new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		clientX: over.x ?? 200,
		clientY: over.y ?? 300,
		pointerId: 1,
		pointerType: over.kind ?? "touch",
		isPrimary: true,
		buttons: over.buttons ?? 0,
	});
	target.dispatchEvent(event);
}

test("a finger that rests on a row lifts it, and letting go without moving opens its menu", async () => {
	load({ folders: [WORK] });
	await page.render(<List />);
	const row = rowOf("scout") as HTMLElement;
	const item = row.closest("li") as HTMLElement;
	await page.act(async () => {
		pointer(row, "pointerdown");
		await until(() => item.hasAttribute("data-lifted"));
	});
	expect(item.hasAttribute("data-lifted")).toBe(true);
	// The menu waits for the finger to lift: nothing is open while the row is held.
	expect(menuItems()).toEqual([]);
	await page.act(() => pointer(row, "pointerup"));
	await settle(80);
	expect(item.hasAttribute("data-lifted")).toBe(false);
	expect(labels().slice(0, 2)).toEqual(["Pin", "Move to folder…"]);
});

test("a finger that goes down within 32 px of a screen edge never lifts a row: the hold opens the menu as before", async () => {
	await page.render(<List />);
	const row = rowOf("scout") as HTMLElement;
	// The menu opens from a timer, so the wait is inside `act` for React to draw it.
	await page.act(async () => {
		pointer(row, "pointerdown", { x: 10 });
		await until(() => menuItems().length > 0);
	});
	expect((row.closest("li") as HTMLElement).hasAttribute("data-lifted")).toBe(
		false,
	);
	expect(labels().slice(0, 2)).toEqual(["Pin", "Move to folder…"]);
});

test("a mouse lifts a row once it moves with the button down, and the click after the drop does not open the row", async () => {
	window.location.hash = "#/rooms";
	load({ folders: [WORK] });
	await page.render(<List />);
	const row = rowOf("scout") as HTMLElement;
	const item = row.closest("li") as HTMLElement;
	await page.act(() =>
		pointer(row, "pointerdown", { kind: "mouse", buttons: 1 }),
	);
	await page.act(() =>
		pointer(row, "pointermove", { kind: "mouse", buttons: 1, y: 320 }),
	);
	await settle(80);
	expect(item.hasAttribute("data-lifted")).toBe(true);
	await page.act(() => pointer(row, "pointerup", { kind: "mouse", y: 320 }));
	await page.click(row);
	expect(window.location.hash).toBe("#/rooms");
	// The next click is an ordinary one again.
	expect(item.hasAttribute("data-lifted")).toBe(false);
});
