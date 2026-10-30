import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import type { ConfigView, RoomView } from "../src/api-types.ts";
import { ActionMenuHost } from "./components/action-menu.tsx";
import { RoomConfirmHost } from "./components/room-confirms.tsx";
import { Toaster } from "./components/toaster.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { closeMenu } from "./lib/action-menu.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { HOLD_MS } from "./lib/long-press.ts";
import { initialState, reduce } from "./lib/rooms.ts";
import { setRouting } from "./lib/router.ts";
import { RoomsPage } from "./pages/rooms.tsx";

const GUIDE = "app:agent.guide";
const RUNNING = "app:thread.0b5e7c1a-0000-4000-8000-000000000001";
const DONE = "app:thread.0b5e7c1a-0000-4000-8000-000000000002";
const OLD = "app:thread.0b5e7c1a-0000-4000-8000-000000000003";

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

const thread = (key: string, title: string, over: Partial<RoomView> = {}) =>
	view(key, {
		kind: "thread",
		name: key.slice(key.indexOf(":") + 1),
		displayName: title,
		parent: GUIDE,
		readOnly: true,
		...over,
	});

let page: TestPage;
let reduced = true;
const realMatchMedia = globalThis.matchMedia;
beforeAll(async () => {
	page = await openPage();
	setRouting(undefined);
	window.innerWidth = 390;
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});
beforeEach(() => {
	reduced = true;
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
	mock.restore();
	await page.act(() => closeMenu());
	await page.render(null);
	await page.act(() => store.dispatch({ type: "rooms_loaded", rooms: [] }));
	Object.defineProperty(globalThis, "matchMedia", {
		value: realMatchMedia,
		configurable: true,
	});
});

const settle = (ms = 40) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

async function show(rooms: RoomView[] = defaultRooms()) {
	await page.render(
		<ConfigContext.Provider value={config}>
			<RoomsPage onSearch={() => undefined} />
			<ActionMenuHost />
			<RoomConfirmHost />
			<Toaster />
		</ConfigContext.Provider>,
	);
	await page.act(() =>
		store.dispatch({ type: "rooms_loaded", rooms: [...rooms] }),
	);
	// The gestures load with the first list of cards.
	await page.act(() => settle(80));
}

const defaultRooms = () => [
	view(GUIDE, { home: true, displayName: "Guide" }),
	thread(RUNNING, "Check the disk"),
	thread(DONE, "Fix the build", { closed: true }),
	thread(OLD, "Earlier job", { closed: true }),
];

const text = () => page.container.textContent ?? "";
/** What the cards show, apart from the notices beside them. */
const listed = () =>
	[...page.container.querySelectorAll(".thread-card")]
		.map((one) => one.textContent)
		.join("|");
const cardOf = (title: string): HTMLElement => {
	const found = [
		...page.container.querySelectorAll<HTMLElement>(".thread-card"),
	].find((one) => one.textContent?.includes(title));
	if (!found) throw new Error(`no card ${title}`);
	// A real card has a width; happy-dom lays nothing out.
	Object.defineProperty(found, "offsetWidth", {
		value: 300,
		configurable: true,
	});
	return found;
};
const linkOf = (title: string) =>
	cardOf(title).querySelector<HTMLElement>(".thread-link") as HTMLElement;

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
			pointerId: 7,
			pointerType: "touch",
			isPrimary: true,
		}),
	);
}

/** A finger from (start, 100) to (end, 100 + sag), in steps, then lifted. */
async function swipe(card: HTMLElement, start: number, end: number, sag = 2) {
	const link = card.querySelector<HTMLElement>(".thread-link") as HTMLElement;
	await page.act(() => touch(link, "pointerdown", start, 100));
	const steps = 6;
	for (let i = 1; i <= steps; i += 1)
		await page.act(() =>
			touch(
				link,
				"pointermove",
				start + ((end - start) * i) / steps,
				100 + (sag * i) / steps,
			),
		);
}
/** Lets go at x; `rest` is how long the finger stayed still first, since a quick lift is a flick. */
const lift = (card: HTMLElement, x: number, rest = 0) =>
	page.act(async () => {
		if (rest) await settle(rest);
		touch(card.querySelector(".thread-link") as Element, "pointerup", x, 102);
		await settle();
	});

const menuItems = (): HTMLElement[] => [
	...document.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
];
const labels = () => menuItems().map((one) => one.textContent);
const choose = async (label: string) => {
	const item = menuItems().find((one) => one.textContent === label);
	if (!item) throw new Error(`no menu item ${label}: ${labels().join(", ")}`);
	await page.click(item);
	await settle(80);
};
const openMenuWith = async (card: HTMLElement) => {
	await page.act(async () => {
		card.dispatchEvent(
			new MouseEvent("contextmenu", {
				bubbles: true,
				cancelable: true,
				clientX: 120,
				clientY: 80,
			}),
		);
		await settle(60);
	});
};

test("a thread is a card: a going-on one and a finished one look different, and only the finished one has a menu button", async () => {
	await show();
	const cards = [
		...page.container.querySelectorAll<HTMLElement>(".thread-card"),
	];
	expect(cards.length).toBe(3);
	expect(cardOf("Check the disk").hasAttribute("data-closed")).toBe(false);
	expect(cardOf("Fix the build").hasAttribute("data-closed")).toBe(true);
	expect(cardOf("Check the disk").textContent).toContain("In progress");
	expect(cardOf("Fix the build").textContent).toContain("Finished");
	const buttons = [...page.container.querySelectorAll(".thread-more")].map(
		(one) => one.getAttribute("aria-label"),
	);
	expect(buttons).toEqual([
		"More actions for Fix the build",
		"More actions for Earlier job",
	]);
	// The whole card is the link, and a going-on thread has no swipe layer under it.
	expect(linkOf("Fix the build").getAttribute("href")).toContain("thread");
	expect(page.container.querySelectorAll(".thread-reveal").length).toBe(2);
});

test("a card's time stands on its status row, so the title keeps the whole row above it", async () => {
	await show();
	for (const title of ["Check the disk", "Fix the build"]) {
		const card = cardOf(title);
		const time = card.querySelector(".room-row-time");
		expect(time).not.toBeNull();
		expect(card.querySelector(".thread-card-top .room-row-time")).toBeNull();
		expect(card.querySelector(".thread-card-meta .room-row-time")).toBe(time);
	}
});

test("only the card's own link is a block: a thread named inside a message stays an inline link", async () => {
	const css = await Bun.file(new URL("./app.css", import.meta.url)).text();
	expect(css).not.toMatch(/\n\.thread-link \{[^}]*display:/);
	expect(css).toMatch(/\n\.thread-card \.thread-link \{[^}]*display: flex/);
});

test("swiping a finished card right past 40 % clears it, closes the gap, and offers an undo that brings it back", async () => {
	const send = spyOn(api, "dismissThread").mockResolvedValue({ dismissed: 1 });
	const back = spyOn(api, "undismissThread").mockResolvedValue({ restored: 1 });
	await show();
	const card = cardOf("Earlier job");
	await swipe(card, 60, 260);
	// The card follows the finger, and says it will go.
	expect(card.style.transform).toContain("translate3d");
	expect(card.hasAttribute("data-armed")).toBe(true);
	await lift(card, 260);
	expect(send).toHaveBeenCalledWith(OLD);
	expect(listed()).not.toContain("Earlier job");
	expect(listed()).toContain("Fix the build");
	expect(text()).toContain("Cleared “Earlier job”");
	const before = store.getState().revision;
	const undo = [...page.container.querySelectorAll("button")].find(
		(one) => one.textContent === "Undo",
	);
	expect(undo).toBeDefined();
	await page.act(async () => {
		undo?.click();
		await settle();
	});
	expect(back).toHaveBeenCalledWith(OLD);
	// The list is read again, which is where the thread comes back from.
	expect(store.getState().revision).toBeGreaterThan(before);
});

test("a short swipe springs back, a sideways flick clears, and a downward drag is a scroll that clears nothing", async () => {
	const send = spyOn(api, "dismissThread").mockResolvedValue({ dismissed: 1 });
	await show();
	const card = cardOf("Earlier job");
	await swipe(card, 60, 130);
	await lift(card, 130, 130);
	expect(send).not.toHaveBeenCalled();
	expect(card.style.transform).toBe("");
	expect(listed()).toContain("Earlier job");

	// Mostly down: the page scrolls, the card stays.
	await swipe(card, 60, 100, 120);
	await lift(card, 100);
	expect(card.style.transform).toBe("");
	expect(send).not.toHaveBeenCalled();

	// A swipe to the left is not ours either.
	await swipe(card, 200, 60);
	await lift(card, 60);
	expect(card.style.transform).toBe("");
	expect(send).not.toHaveBeenCalled();

	// A touch that begins at the screen edge belongs to the system's Back.
	await swipe(card, 10, 260);
	await lift(card, 260);
	expect(send).not.toHaveBeenCalled();
});

test("a going-on thread does not swipe away: it gives a little and pulls back", async () => {
	const send = spyOn(api, "dismissThread").mockResolvedValue({ dismissed: 1 });
	await show();
	const card = cardOf("Check the disk");
	await swipe(card, 60, 300);
	const pulled = Number.parseFloat(
		card.style.transform.replace(/translate3d\(([\d.]+)px.*/, "$1"),
	);
	expect(pulled).toBeGreaterThan(0);
	expect(pulled).toBeLessThanOrEqual(24);
	expect(card.hasAttribute("data-armed")).toBe(false);
	await lift(card, 300);
	expect(card.style.transform).toBe("");
	expect(send).not.toHaveBeenCalled();
	expect(listed()).toContain("Check the disk");
});

test("the card slides out and the list closes the gap unless the person asked for less motion", async () => {
	reduced = false;
	const send = spyOn(api, "dismissThread").mockResolvedValue({ dismissed: 1 });
	await show();
	const card = cardOf("Earlier job");
	await swipe(card, 60, 260);
	await page.act(() => {
		touch(card.querySelector(".thread-link") as Element, "pointerup", 260, 102);
	});
	// It leaves first; the server hears of it once it has gone.
	expect(card.style.transform).toBe("translate3d(110%, 0, 0)");
	expect(send).not.toHaveBeenCalled();
	await page.act(() => settle(420));
	expect(send).toHaveBeenCalledWith(OLD);
	expect(listed()).not.toContain("Earlier job");
});

test("a card the server will not clear comes back where it was, with the reason", async () => {
	spyOn(api, "dismissThread").mockRejectedValue(
		new Error("The thread is still open."),
	);
	await show();
	const card = cardOf("Fix the build");
	await swipe(card, 60, 260);
	await lift(card, 260);
	expect(listed()).toContain("Fix the build");
	expect(text()).toContain("The thread is still open.");
	expect(card.style.transform).toBe("");
	expect(card.style.opacity).toBe("");
});

test("the swipe that clears a card does not also open it", async () => {
	spyOn(api, "dismissThread").mockRejectedValue(new Error("no"));
	await show();
	const card = cardOf("Fix the build");
	let clicks = 0;
	card.addEventListener("click", () => {
		clicks += 1;
	});
	await swipe(card, 60, 260);
	await lift(card, 260);
	await page.act(() =>
		(card.querySelector(".thread-link") as HTMLElement).click(),
	);
	expect(clicks).toBe(0);
	// The next tap opens it as usual.
	await page.act(() =>
		(card.querySelector(".thread-link") as HTMLElement).click(),
	);
	expect(clicks).toBe(1);
});

test("holding a card opens a menu to clear this one or every finished one, and clearing all tells the server once", async () => {
	const send = spyOn(api, "dismissThreads").mockResolvedValue({ dismissed: 2 });
	await show();
	const card = cardOf("Fix the build");
	await page.act(() =>
		touch(
			card.querySelector(".thread-link") as Element,
			"pointerdown",
			100,
			100,
		),
	);
	await page.act(() => settle(HOLD_MS + 80));
	expect(labels()).toEqual(["Clear this thread", "Clear all finished"]);
	await page.act(() =>
		touch(card.querySelector(".thread-link") as Element, "pointerup", 100, 100),
	);
	await choose("Clear all finished");
	expect(send).toHaveBeenCalledTimes(1);
	expect(send).toHaveBeenCalledWith(GUIDE);
	expect(listed()).not.toContain("Fix the build");
	expect(listed()).not.toContain("Earlier job");
	expect(listed()).toContain("Check the disk");
	expect(text()).toContain("Cleared 2 finished threads");
});

test("a right click on a finished card offers both, and on a going-on one only the clear-all", async () => {
	const send = spyOn(api, "dismissThread").mockResolvedValue({ dismissed: 1 });
	await show();
	await openMenuWith(cardOf("Fix the build"));
	expect(labels()).toEqual(["Clear this thread", "Clear all finished"]);
	await choose("Clear this thread");
	expect(send).toHaveBeenCalledWith(DONE);
	expect(listed()).not.toContain("Fix the build");
	await openMenuWith(cardOf("Check the disk"));
	expect(labels()).toEqual(["Clear all finished"]);
	await page.act(() => closeMenu());
});

test("a going-on thread with nothing finished beside it has no menu", async () => {
	await show([view(GUIDE, { home: true }), thread(RUNNING, "Check the disk")]);
	await openMenuWith(cardOf("Check the disk"));
	expect(labels()).toEqual([]);
});

test("the menu button of a finished card opens the same menu", async () => {
	await show();
	const button = page.container.querySelector<HTMLElement>(
		'[aria-label="More actions for Earlier job"]',
	);
	await page.act(async () => {
		button?.click();
		await settle(80);
	});
	expect(labels()).toEqual(["Clear this thread", "Clear all finished"]);
});

test("Delete on a focused finished card clears it and moves focus to its neighbour; on a going-on one it does nothing", async () => {
	const send = spyOn(api, "dismissThread").mockResolvedValue({ dismissed: 1 });
	await show();
	const press = (title: string) =>
		page.act(async () => {
			linkOf(title).dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "Delete",
					bubbles: true,
					cancelable: true,
				}),
			);
			await settle();
		});
	await press("Check the disk");
	expect(send).not.toHaveBeenCalled();
	linkOf("Fix the build").focus();
	await press("Fix the build");
	expect(send).toHaveBeenCalledWith(DONE);
	expect(listed()).not.toContain("Fix the build");
	expect(document.activeElement).toBe(linkOf("Earlier job"));
});

test("the Menu key opens the card's menu", async () => {
	await show();
	await page.act(async () => {
		linkOf("Fix the build").dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "ContextMenu",
				bubbles: true,
				cancelable: true,
			}),
		);
		await settle(60);
	});
	expect(labels()).toEqual(["Clear this thread", "Clear all finished"]);
});

test("the header's Clear finished clears the finished threads at once, with no question, however many there are", async () => {
	const send = spyOn(api, "dismissThreads").mockResolvedValue({ dismissed: 2 });
	await show();
	const clear = () =>
		[...page.container.querySelectorAll("button")].find(
			(one) => one.textContent === "Clear finished",
		);
	await page.act(async () => {
		clear()?.click();
		await settle(80);
	});
	expect(send).toHaveBeenCalledWith(GUIDE);
	expect(listed()).not.toContain("Earlier job");
});

test("clearing more than five goes ahead at once too: no question, and the notice's Undo brings them back", async () => {
	const send = spyOn(api, "dismissThreads").mockResolvedValue({ dismissed: 6 });
	const back = spyOn(api, "undismissThreads").mockResolvedValue({
		restored: 6,
	});
	const many = Array.from({ length: 6 }, (_, i) =>
		thread(`app:thread.0b5e7c1a-0000-4000-8000-0000000001${i}0`, `Job ${i}`, {
			closed: true,
		}),
	);
	await show([view(GUIDE, { home: true }), ...many]);
	await page.act(async () => {
		[...page.container.querySelectorAll("button")]
			.find((one) => one.textContent === "Clear finished")
			?.click();
		await settle(120);
	});
	expect(document.body.textContent).not.toContain("finished threads?");
	expect(send).toHaveBeenCalledWith(GUIDE);
	expect(listed()).not.toContain("Job 3");
	expect(document.body.textContent).toContain("Cleared 6 finished threads");
	await page.act(async () => {
		[...document.querySelectorAll("button")]
			.filter((one) => one.textContent === "Undo")
			.at(-1)
			?.click();
		await settle(80);
	});
	expect(back).toHaveBeenCalledWith(
		GUIDE,
		many.map((one) => one.key),
	);
});

test("a thread opened by its address joins the state without joining the list", () => {
	let state = reduce(initialState(), {
		type: "rooms_loaded",
		rooms: [view(GUIDE, { home: true })],
	});
	state = reduce(state, {
		type: "room_viewed",
		view: thread(OLD, "Earlier job", { closed: true }),
	});
	expect(state.rooms[OLD]?.view?.displayName).toBe("Earlier job");
	expect(state.order).toEqual([GUIDE]);
	state = reduce(
		reduce(state, {
			type: "rooms_loaded",
			rooms: [
				view(GUIDE, { home: true }),
				thread(DONE, "Fix", { closed: true }),
			],
		}),
		{ type: "threads_dismissed", rooms: [DONE] },
	);
	expect(state.order).toEqual([GUIDE]);
});
