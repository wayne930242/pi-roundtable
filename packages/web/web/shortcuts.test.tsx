import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	test,
} from "bun:test";
import type { FolderView, RoomView } from "../src/api-types.ts";
import { ActionMenuHost } from "./components/action-menu.tsx";
import { SheetHosts } from "./components/sheet-hosts.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { closeMenu, openMenu } from "./lib/action-menu.ts";
import { store } from "./lib/app-store.ts";
import { reloadCollapsed, toggleCollapsed } from "./lib/folds.ts";
import { loadKit } from "./lib/kit.ts";
import { loadBuiltInMessages, setPresentation } from "./lib/messages.ts";
import { currentRoute, setRouting } from "./lib/router.ts";
import { isSearchKey } from "./lib/search-key.ts";
import { closeShortcutHelp } from "./lib/shortcut-help.ts";
import { startShortcuts } from "./lib/shortcuts.ts";

const HOME = "app:agent.guide";
const A = "app:agent.a";
const B = "app:agent.b";
const C = "app:agent.c";
const G = "app:group.g";
const F1 = "folder.00000000-0000-4000-8000-000000000001";

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

function load(
	unread: Record<string, number> = {},
	folders: FolderView[] = [],
): void {
	const rooms = [HOME, A, B, C, G].map((key) =>
		view(key, { home: key === HOME, unread: unread[key] ?? 0 }),
	);
	store.dispatch({ type: "rooms_loaded", rooms, pins: [], folders });
}

const at = (key: string) => {
	window.location.hash = `#/room/${encodeURIComponent(key)}`;
};
const open = () => currentRoute().key;

interface Press {
	key: string;
	init?: KeyboardEventInit;
}

/** Sends a key to `target` the way a browser does, and returns the event to see whether it was claimed. */
function press(target: Element, { key, init = {} }: Press): KeyboardEvent {
	const event = new KeyboardEvent("keydown", {
		key,
		bubbles: true,
		cancelable: true,
		...init,
	});
	target.dispatchEvent(event);
	return event;
}
const alt = (key: string, init: KeyboardEventInit = {}): Press => ({
	key,
	init: { altKey: true, ...init },
});

let page: TestPage;
let stop: (() => void) | undefined;
let field: HTMLTextAreaElement;
beforeAll(async () => {
	await loadKit();
	page = await openPage();
	setRouting(undefined);
	window.innerWidth = 1280;
	field = document.createElement("textarea");
	document.body.append(field);
});
afterAll(async () => {
	field.remove();
	await page.unmount();
	await releaseDom();
});
beforeEach(() => {
	localStorage.clear();
	reloadCollapsed();
	load();
	at(A);
	field.value = "";
	stop = startShortcuts();
});
afterEach(async () => {
	stop?.();
	await page.act(() => {
		closeShortcutHelp();
		closeMenu();
	});
	await page.render(null);
	for (const one of document.querySelectorAll("dialog.fake")) one.remove();
	document.body.focus();
});

test("Alt+↓ and Alt+↑ go to the next and the previous room in the list's order, and stop at the ends", () => {
	const down = press(document.body, alt("ArrowDown"));
	expect(down.defaultPrevented).toBe(true);
	expect(open()).toBe(B);
	press(document.body, alt("ArrowDown"));
	press(document.body, alt("ArrowDown"));
	expect(open()).toBe(G);
	press(document.body, alt("ArrowDown"));
	expect(open()).toBe(G);
	press(document.body, alt("ArrowUp"));
	expect(open()).toBe(C);
	at(HOME);
	press(document.body, alt("ArrowUp"));
	expect(open()).toBe(HOME);
});

test("a page that shows no room starts from the ends of the list", () => {
	window.location.hash = "#/settings";
	press(document.body, alt("ArrowDown"));
	expect(open()).toBe(HOME);
	window.location.hash = "#/settings";
	press(document.body, alt("ArrowUp"));
	expect(open()).toBe(G);
});

test("keys that belong to other things are left alone: plain arrows, Shift, Ctrl and ⌘ with arrows, Alt+←", () => {
	for (const press_ of [
		{ key: "ArrowDown" },
		{ key: "ArrowDown", init: { shiftKey: true } },
		{ key: "ArrowDown", init: { ctrlKey: true } },
		{ key: "ArrowDown", init: { metaKey: true } },
		{ key: "ArrowDown", init: { altKey: true, metaKey: true } },
		{ key: "ArrowDown", init: { altKey: true, ctrlKey: true } },
		alt("ArrowLeft"),
	] satisfies Press[]) {
		const event = press(document.body, press_);
		expect(event.defaultPrevented).toBe(false);
		expect(open()).toBe(A);
	}
});

test("nothing happens while an input method composes", () => {
	for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
		const event = press(document.body, alt("ArrowDown", init));
		expect(event.defaultPrevented).toBe(false);
		expect(open()).toBe(A);
	}
});

test("a key a widget already handled is not taken again", () => {
	const handled = (event: Event) => event.preventDefault();
	field.addEventListener("keydown", handled, { once: true });
	press(field, alt("ArrowDown"));
	expect(open()).toBe(A);
});

test("in a text field Alt+↓ acts at the very end and Alt+↑ at the very start, and an empty field takes both", () => {
	field.value = "hello";
	field.focus();
	field.setSelectionRange(2, 2);
	for (const key of ["ArrowDown", "ArrowUp"]) {
		const event = press(field, alt(key));
		expect(event.defaultPrevented).toBe(false);
		expect(open()).toBe(A);
	}
	// A selection is never the caret at an edge.
	field.setSelectionRange(0, 5);
	press(field, alt("ArrowDown"));
	press(field, alt("ArrowUp"));
	expect(open()).toBe(A);
	field.setSelectionRange(5, 5);
	expect(press(field, alt("ArrowUp")).defaultPrevented).toBe(false);
	expect(open()).toBe(A);
	expect(press(field, alt("ArrowDown")).defaultPrevented).toBe(true);
	expect(open()).toBe(B);
	field.setSelectionRange(0, 0);
	expect(press(field, alt("ArrowDown")).defaultPrevented).toBe(false);
	expect(open()).toBe(B);
	expect(press(field, alt("ArrowUp")).defaultPrevented).toBe(true);
	expect(open()).toBe(A);
	field.value = "";
	press(field, alt("ArrowDown"));
	expect(open()).toBe(B);
	press(field, alt("ArrowUp"));
	expect(open()).toBe(A);
	expect(field.value).toBe("");
});

test("Alt+Shift+↓ and Alt+Shift+↑ go to the next and the previous room with unread messages", () => {
	load({ [B]: 2, [G]: 1 });
	press(document.body, alt("ArrowDown", { shiftKey: true }));
	expect(open()).toBe(B);
	press(document.body, alt("ArrowDown", { shiftKey: true }));
	expect(open()).toBe(G);
	// None after the last, and the run does not wrap.
	const end = press(document.body, alt("ArrowDown", { shiftKey: true }));
	expect(end.defaultPrevented).toBe(true);
	expect(open()).toBe(G);
	press(document.body, alt("ArrowUp", { shiftKey: true }));
	expect(open()).toBe(B);
	press(document.body, alt("ArrowUp", { shiftKey: true }));
	expect(open()).toBe(B);
});

test("the unread jump follows the list's order: folders before the rest, and a folded folder is still searched", () => {
	const folders = [{ id: F1, name: "One", rooms: [G, C] }];
	load({ [B]: 1, [C]: 1 }, folders);
	at(HOME);
	// Home, then the folder (G, C), then the rest (A, B).
	press(document.body, alt("ArrowDown", { shiftKey: true }));
	expect(open()).toBe(C);
	toggleCollapsed(F1);
	at(HOME);
	press(document.body, alt("ArrowDown", { shiftKey: true }));
	expect(open()).toBe(C);
	press(document.body, alt("ArrowDown", { shiftKey: true }));
	expect(open()).toBe(B);
});

test("Alt+↓ follows the folders in the list and skips a folded folder, unless the open room is in it", () => {
	load({}, [{ id: F1, name: "One", rooms: [G, C] }]);
	at(HOME);
	press(document.body, alt("ArrowDown"));
	expect(open()).toBe(G);
	press(document.body, alt("ArrowDown"));
	expect(open()).toBe(C);
	press(document.body, alt("ArrowDown"));
	expect(open()).toBe(A);
	toggleCollapsed(F1);
	at(HOME);
	press(document.body, alt("ArrowDown"));
	expect(open()).toBe(A);
	press(document.body, alt("ArrowUp"));
	expect(open()).toBe(HOME);
	// The folder holding the open room shows open, whatever was kept.
	at(G);
	press(document.body, alt("ArrowDown"));
	expect(open()).toBe(C);
});

test("a room open that the list does not hold stays where it is", () => {
	window.location.hash = `#/room/${encodeURIComponent("app:host.thing")}`;
	press(document.body, alt("ArrowDown"));
	expect(open()).toBe("app:host.thing");
});

test("an open menu or sheet keeps the room keys to itself", () => {
	const fake = document.createElement("dialog");
	fake.className = "fake";
	fake.setAttribute("open", "");
	document.body.append(fake);
	const event = press(document.body, alt("ArrowDown"));
	expect(event.defaultPrevented).toBe(false);
	expect(open()).toBe(A);
});

test("Esc lets go of the message box and keeps what was typed", () => {
	field.value = "a draft";
	field.focus();
	expect(document.activeElement).toBe(field);
	const event = press(field, { key: "Escape" });
	expect(event.defaultPrevented).toBe(true);
	expect(document.activeElement).not.toBe(field);
	expect(field.value).toBe("a draft");
});

test("Esc does not blur while an input method composes", () => {
	field.focus();
	press(field, { key: "Escape", init: { isComposing: true } });
	expect(document.activeElement).toBe(field);
});

test("Esc closes an open menu first, and the box keeps focus until a second Esc", async () => {
	await page.render(<ActionMenuHost />);
	field.focus();
	await page.act(() =>
		openMenu({
			title: "Room",
			items: [{ id: "one", label: "One", run: () => undefined }],
			at: { x: 10, y: 10 },
			via: "key",
			source: field,
		}),
	);
	expect(document.querySelector(".action-popover")).not.toBeNull();
	// Focus is outside the menu, as when it was opened with the pointer.
	field.focus();
	await page.act(() => {
		press(field, { key: "Escape" });
	});
	expect(document.querySelector(".action-popover")).toBeNull();
	expect(field.value).toBe("");
	press(field, { key: "Escape" });
	expect(document.activeElement).not.toBe(field);
});

test("Esc leaves a sheet to close itself, and the box keeps focus", () => {
	const fake = document.createElement("dialog");
	fake.className = "fake";
	fake.setAttribute("open", "");
	document.body.append(fake);
	field.focus();
	const event = press(field, { key: "Escape" });
	expect(event.defaultPrevented).toBe(false);
	expect(document.activeElement).toBe(field);
});

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(done: () => boolean, ms = 4000): Promise<void> {
	const stop = Date.now() + ms;
	while (!done() && Date.now() < stop) await settle(25);
}

test("? opens the shortcut list, which loads only then, and a second ? closes it; a text field keeps the character", async () => {
	await page.render(<SheetHosts />);
	expect(document.querySelector(".shortcut-list")).toBeNull();
	field.focus();
	const typed = press(field, { key: "?", init: { shiftKey: true } });
	expect(typed.defaultPrevented).toBe(false);
	await settle();
	expect(document.querySelector(".shortcut-list")).toBeNull();

	field.blur();
	let event: KeyboardEvent | undefined;
	await page.act(() => {
		event = press(document.body, { key: "?", init: { shiftKey: true } });
	});
	expect(event?.defaultPrevented).toBe(true);
	await page.act(() =>
		until(() => document.querySelector(".shortcut-list") !== null),
	);
	const list = document.querySelector(".shortcut-list");
	expect(list?.textContent).toContain("Previous room");
	expect(list?.textContent).toContain("Next room with unread messages");
	expect(list?.querySelectorAll("kbd").length).toBeGreaterThan(8);
	expect(document.querySelector("dialog")?.hasAttribute("open")).toBe(true);

	await page.act(() => {
		press(document.body, { key: "?", init: { shiftKey: true } });
	});
	await page.act(() =>
		until(() => document.querySelector("dialog[open]") === null),
	);
	expect(document.querySelector("dialog[open]")).toBeNull();
});

test("the shortcut list is worded in zh-TW with the knight vocabulary", async () => {
	await loadBuiltInMessages("zh-TW");
	setPresentation({
		title: "Console",
		panes: [],
		timeZone: "UTC",
		locale: "zh-TW",
	});
	try {
		await page.render(<SheetHosts />);
		await page.act(() => {
			press(document.body, { key: "?", init: { shiftKey: true } });
		});
		await page.act(() =>
			until(() => document.querySelector(".shortcut-list") !== null),
		);
		const text = document.querySelector("dialog")?.textContent ?? "";
		expect(text).toContain("\u9375\u76e4\u5feb\u901f\u9375");
		expect(text).toContain(
			"\u4e0a\u4e00\u500b\u6709\u672a\u8b80\u8a0a\u606f\u7684\u804a\u5929\u5ba4",
		);
		expect(text).not.toMatch(/\u5925\u4f34|\u52a9\u7406/);
	} finally {
		setPresentation({ title: "Console", panes: [], timeZone: "UTC" });
		await loadBuiltInMessages(undefined);
	}
});

test("? is left alone behind another sheet", async () => {
	await page.render(<SheetHosts />);
	const fake = document.createElement("dialog");
	fake.className = "fake";
	fake.setAttribute("open", "");
	document.body.append(fake);
	press(document.body, { key: "?", init: { shiftKey: true } });
	await settle(150);
	expect(document.querySelector(".shortcut-list")).toBeNull();
});

test("Ctrl+K and ⌘K are the search key wherever focus is, and not while an input method composes", () => {
	const seen: boolean[] = [];
	const listen = (event: KeyboardEvent) => seen.push(isSearchKey(event));
	window.addEventListener("keydown", listen);
	try {
		press(field, { key: "k", init: { ctrlKey: true } });
		press(field, { key: "K", init: { metaKey: true } });
		press(document.body, { key: "k", init: { metaKey: true } });
		press(field, { key: "k" });
		press(field, { key: "k", init: { ctrlKey: true, isComposing: true } });
		press(field, { key: "k", init: { ctrlKey: true, keyCode: 229 } });
		press(field, { key: "j", init: { ctrlKey: true } });
	} finally {
		window.removeEventListener("keydown", listen);
	}
	expect(seen).toEqual([true, true, true, false, false, false, false]);
});
