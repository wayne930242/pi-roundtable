import { afterEach, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { chatsConfig, Home, loadChats, NEWS, seed } from "./chats-fixture.tsx";
import {
	all,
	BUILD,
	foldersPage,
	labels,
	page,
	q,
	rightClick,
	SCOUT,
	settle,
	until,
} from "./folders-fixture.tsx";
import { closeMenu } from "./lib/action-menu.ts";
import { bulkApi } from "./lib/bulk-api.ts";
import { ConfigContext } from "./lib/config.ts";
import { seedUnread } from "./lib/host-state.ts";
import { HOLD_MS } from "./lib/long-press.ts";
import { currentRoute } from "./lib/router.ts";
import { isSearchKey } from "./lib/search-key.ts";
import { startShortcuts } from "./lib/shortcuts.ts";
import ChatsHome from "./pages/chats-home.tsx";

foldersPage();

beforeAll(async () => {
	// The gesture loads after the list; loading it now keeps that out of the first test.
	await import("./lib/read-swipe.ts");
	await import("./lib/drag.ts");
});
afterEach(() => page.act(() => closeMenu()));

const show = async (node: React.ReactNode) => {
	await page.render(node);
	await until(() => q(".chats") !== null && all(".chat-row, .pin").length > 0);
	await page.act(() => settle(80));
};
const row = (key: string): HTMLElement => {
	const found = q(`a.chat-row[data-room="${key}"]`);
	if (!found) throw new Error(`no row ${key}`);
	Object.defineProperty(found, "offsetWidth", {
		value: 300,
		configurable: true,
	});
	return found;
};
const touch = (
	target: Element,
	type: "pointerdown" | "pointermove" | "pointerup",
	x: number,
	y: number,
) =>
	target.dispatchEvent(
		new PointerEvent(type, {
			bubbles: true,
			cancelable: true,
			clientX: x,
			clientY: y,
			pointerId: 7,
			pointerType: "touch",
			isPrimary: true,
		}),
	);
const hold = (target: Element) =>
	page.act(async () => {
		touch(target, "pointerdown", 100, 100);
		await settle(HOLD_MS + 80);
		touch(target, "pointerup", 100, 100);
		await settle(80);
	});
const swipe = async (
	target: Element,
	from: number,
	to: number,
	sag: number,
) => {
	await page.act(() => touch(target, "pointerdown", from, 100));
	for (let i = 1; i <= 6; i += 1)
		await page.act(() =>
			touch(
				target,
				"pointermove",
				from + ((to - from) * i) / 6,
				100 + (sag * i) / 6,
			),
		);
	await page.act(async () => {
		await settle(260);
		touch(target, "pointerup", to, 100 + sag);
		await settle();
	});
};
const key = (name: string, init: KeyboardEventInit = {}) => {
	const event = new KeyboardEvent("keydown", {
		key: name,
		bubbles: true,
		cancelable: true,
		...init,
	});
	document.body.dispatchEvent(event);
	return event;
};

test("a right click on a row opens the room's menu on the chat home", async () => {
	loadChats({});
	seed(0, { [NEWS]: 2 });
	await show(<Home />);
	await rightClick(row(NEWS));
	expect(labels()).toContain("Mark as read");
	expect(labels()).toContain("Hide");
});

test("a hold on a row, on a pin and on a dock pin opens the same menu", async () => {
	loadChats({ pins: [BUILD] });
	seed(0, { [NEWS]: 2 });
	await show(<Home />);
	await hold(row(NEWS));
	expect(labels()).toContain("Mark as read");
	await page.act(() => closeMenu());
	await hold(q(`[data-room-pin="${BUILD}"]`) as HTMLElement);
	expect(labels()).toContain("Hide");
	await page.act(() => closeMenu());
	await show(<Home column />);
	await rightClick(q(`.pins [data-room-pin="${BUILD}"]`));
	expect(labels()).toContain("Hide");
});

test("a swipe right on a row marks its room read; a vertical scroll and a swipe left mark nothing", async () => {
	const readAll = spyOn(bulkApi, "readAll").mockResolvedValue({
		moved: [{ room: NEWS, from: 2, to: 5 }],
	});
	try {
		loadChats({});
		seed(0, { [NEWS]: 2 });
		await show(<Home />);
		await swipe(row(NEWS), 260, 60, 2);
		await swipe(row(NEWS), 60, 70, 140);
		expect(readAll).not.toHaveBeenCalled();
		await swipe(row(NEWS), 60, 260, 2);
		expect(readAll).toHaveBeenCalledTimes(1);
		expect(readAll.mock.calls[0]?.[0]).toEqual([NEWS]);
	} finally {
		readAll.mockRestore();
		seedUnread({ [NEWS]: 0 });
	}
});

test("the search button asks for the search, and ⌘K and Ctrl+K are still the search key", async () => {
	loadChats({});
	seed();
	const onSearch = mock(() => undefined);
	await show(
		<ConfigContext.Provider value={chatsConfig}>
			<ChatsHome onSearch={onSearch} />
		</ConfigContext.Provider>,
	);
	const button = q<HTMLButtonElement>("button.chats-search");
	expect(button?.textContent).toContain("⌘K");
	await page.click(button);
	expect(onSearch).toHaveBeenCalledTimes(1);
	const seen: boolean[] = [];
	const listen = (event: KeyboardEvent) => seen.push(isSearchKey(event));
	window.addEventListener("keydown", listen);
	try {
		key("k", { metaKey: true });
		key("k", { ctrlKey: true });
		key("k");
	} finally {
		window.removeEventListener("keydown", listen);
	}
	expect(seen).toEqual([true, true, false]);
});

test("Alt+↓ and Alt+↑ still step through the rooms from the chat home", async () => {
	loadChats({ pins: [BUILD] });
	seed();
	await show(<Home />);
	const stop = startShortcuts();
	try {
		window.location.hash = `#/room/${encodeURIComponent(BUILD)}`;
		await page.act(() => settle(20));
		key("ArrowDown", { altKey: true });
		const next = currentRoute().key;
		expect(next).toBeDefined();
		expect(next).not.toBe(BUILD);
		key("ArrowUp", { altKey: true });
		expect(currentRoute().key).toBe(BUILD);
		seedUnread({ [NEWS]: 1 });
		key("ArrowDown", { altKey: true, shiftKey: true });
		expect(currentRoute().key).toBe(NEWS);
	} finally {
		stop();
		seedUnread({ [NEWS]: 0 });
		window.location.hash = "";
	}
});
