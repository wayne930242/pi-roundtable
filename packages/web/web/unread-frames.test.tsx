import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { partial } from "pi-roundtable/testing";
import type { ConfigView, RoomMessage, RoomView } from "../src/api-types.ts";
import { GLANCE_MS } from "./components/unread-frames.ts";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { keepReads } from "./lib/host-state.ts";
import { setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import { RoomPage } from "./pages/room.tsx";

// Each test opens a room of its own: the store keeps the messages a room already holds, and the
// page remembers which frames were cleared.
let opened = 0;
const config: ConfigView = {
	title: "Console",
	panes: ["rooms"],
	timeZone: "UTC",
	look: "modern",
};

const message = (
	room: string,
	id: number,
	over: Partial<RoomMessage> = {},
): RoomMessage => ({
	id,
	room,
	kind: "agent",
	author: "Scout",
	agent: "scout",
	text: `message ${id}`,
	files: [],
	at: `2026-10-30T10:0${id}:00.000Z`,
	...over,
});

const mine = (room: string, id: number): RoomMessage =>
	message(room, id, {
		kind: "owner",
		principalId: "ada",
		author: "Ada",
		agent: undefined,
	});

let page: TestPage;
beforeAll(async () => {
	page = await openPage();
	setRouting(undefined);
	setConnection(
		partial<AppConnection>({ send: () => true, focus: () => undefined }),
	);
});
afterAll(async () => {
	setConnection(undefined);
	await page.unmount();
	await releaseDom();
});

const settle = (ms = 60) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Opens an agent room as Ada, whose read marker stands at `cursor`. */
async function open(
	cursor: number,
	messages: (room: string) => RoomMessage[],
): Promise<{ room: string; restore: () => void }> {
	const key = `app:agent.unread${++opened}`;
	const view: RoomView = {
		key,
		kind: "agent",
		name: `unread${opened}`,
		displayName: `unread${opened}`,
		home: false,
		readOnly: false,
		mode: { yolo: false, longRunning: false },
		typing: false,
		stoppable: false,
	};
	const history = spyOn(api, "messages").mockResolvedValue({
		messages: messages(key),
		more: false,
		cards: [],
	});
	store.dispatch({ type: "rooms_loaded", rooms: [view] });
	store.dispatch({
		type: "ready",
		protocol: 1,
		principal: "ada",
		name: "Ada",
		uploads: { perMessage: 4, maxBytes: 1000 },
	});
	keepReads(key, [], cursor);
	await page.render(
		<ConfigContext.Provider value={config}>
			<RoomPage key={key} roomKey={key} />
		</ConfigContext.Provider>,
	);
	await page.act(() => settle(120));
	return { room: key, restore: () => history.mockRestore() };
}

const row = (id: number) =>
	page.container.querySelector<HTMLElement>(`li.message[data-mid="${id}"]`);
const framed = () =>
	[...page.container.querySelectorAll<HTMLElement>("li[data-unread]")].map(
		(item) => Number(item.dataset.mid),
	);

const pointer = (type: string, pointerType: string) =>
	Object.assign(new Event(type, { bubbles: true }), { pointerType });

afterEach(() => {
	Object.defineProperty(document, "visibilityState", {
		value: "visible",
		configurable: true,
	});
});

test("messages past the read marker wear a frame as the room opens; read and own ones do not", async () => {
	const { restore } = await open(2, (room) => [
		message(room, 1),
		message(room, 2),
		message(room, 3),
		mine(room, 4),
		message(room, 5, { kind: "system", agent: undefined, text: "A line" }),
		message(room, 6),
	]);
	try {
		expect(framed()).toEqual([3, 6]);
	} finally {
		restore();
	}
});

test("a pointer passing over a message clears its frame and no other", async () => {
	const { restore } = await open(1, (room) => [
		message(room, 1),
		message(room, 2),
		message(room, 3),
	]);
	try {
		expect(framed()).toEqual([2, 3]);
		const target = row(2)?.querySelector(".bubble");
		if (!target) throw new Error("no bubble");
		await page.act(() => {
			target.dispatchEvent(pointer("pointerover", "mouse"));
		});
		expect(framed()).toEqual([3]);
	} finally {
		restore();
	}
});

test("a finger touching down does not clear a frame by passing over; a tap does", async () => {
	const { restore } = await open(1, (room) => [
		message(room, 1),
		message(room, 2),
		message(room, 3),
	]);
	try {
		const target = row(3)?.querySelector(".bubble");
		if (!target) throw new Error("no bubble");
		await page.act(() => {
			target.dispatchEvent(pointer("pointerover", "touch"));
		});
		expect(framed()).toEqual([2, 3]);
		await page.click(row(3));
		expect(framed()).toEqual([2]);
	} finally {
		restore();
	}
});

test("keyboard focus reaching a message clears its frame", async () => {
	const { restore } = await open(1, (room) => [
		message(room, 1),
		message(room, 2),
		message(room, 3),
	]);
	try {
		const target = row(2);
		if (!target) throw new Error("no row");
		await page.act(() => {
			target.dispatchEvent(new Event("focusin", { bubbles: true }));
		});
		expect(framed()).toEqual([3]);
	} finally {
		restore();
	}
});

test("a cleared frame stays cleared when the room is opened again in the same page", async () => {
	const first = await open(1, (room) => [
		message(room, 1),
		message(room, 2),
		message(room, 3),
	]);
	try {
		await page.click(row(2));
		expect(framed()).toEqual([3]);
		await page.render(<div />);
		await page.render(
			<ConfigContext.Provider value={config}>
				<RoomPage key={first.room} roomKey={first.room} />
			</ConfigContext.Provider>,
		);
		await page.act(() => settle(120));
		expect(framed()).toEqual([3]);
	} finally {
		first.restore();
	}
});

test("a message that arrives while the person watches the end is not framed; one that arrives while the tab is hidden is", async () => {
	const { room, restore } = await open(1, (key) => [
		message(key, 1),
		message(key, 2),
	]);
	try {
		expect(framed()).toEqual([2]);
		await page.act(() => {
			store.dispatch({ type: "message", room, message: message(room, 3) });
		});
		expect(framed()).toEqual([2]);
		Object.defineProperty(document, "visibilityState", {
			value: "hidden",
			configurable: true,
		});
		await page.act(() => {
			store.dispatch({ type: "message", room, message: message(room, 4) });
		});
		expect(framed()).toEqual([2, 4]);
	} finally {
		restore();
	}
});

test("a message that arrives while the log is scrolled away from its end is framed", async () => {
	const { room, restore } = await open(2, (key) => [
		message(key, 1),
		message(key, 2),
	]);
	try {
		const scroller = page.container.querySelector<HTMLElement>(".room-scroll");
		if (!scroller) throw new Error("no scroller");
		Object.defineProperty(scroller, "scrollHeight", {
			value: 2000,
			configurable: true,
		});
		Object.defineProperty(scroller, "clientHeight", {
			value: 500,
			configurable: true,
		});
		scroller.scrollTop = 100;
		await page.act(() => {
			store.dispatch({ type: "message", room, message: message(room, 3) });
		});
		expect(framed()).toEqual([3]);
	} finally {
		restore();
	}
});

// ── Touch screens ──────────────────────────────────────────────────────────────────────────────────

interface Watch {
	callback: IntersectionObserverCallback;
	targets: Set<Element>;
}

/** Stands in for the browser's IntersectionObserver and for a coarse pointer, until `undo` runs. */
function touchScreen(): { watchers: Watch[]; undo: () => void } {
	const watchers: Watch[] = [];
	const before = {
		observer: Reflect.get(globalThis, "IntersectionObserver"),
		media: Reflect.get(globalThis, "matchMedia"),
	};
	class FakeObserver {
		readonly watch: Watch;
		constructor(callback: IntersectionObserverCallback) {
			this.watch = { callback, targets: new Set() };
			watchers.push(this.watch);
		}
		observe(target: Element) {
			this.watch.targets.add(target);
		}
		unobserve(target: Element) {
			this.watch.targets.delete(target);
		}
		disconnect() {
			this.watch.targets.clear();
		}
	}
	Reflect.set(globalThis, "IntersectionObserver", FakeObserver);
	Reflect.set(globalThis, "matchMedia", (query: string) => ({
		matches: query === "(pointer: coarse)",
		media: query,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
	}));
	return {
		watchers,
		undo: () => {
			Reflect.set(globalThis, "IntersectionObserver", before.observer);
			Reflect.set(globalThis, "matchMedia", before.media);
		},
	};
}

/** Tells the live observer how much of `target` is in view. */
function inView(watchers: Watch[], target: Element, ratio: number): void {
	const watch = watchers.findLast((one) => one.targets.has(target));
	if (!watch) throw new Error("the message is not watched");
	watch.callback(
		[
			partial<IntersectionObserverEntry>({
				target,
				isIntersecting: ratio > 0,
				intersectionRatio: ratio,
				intersectionRect: partial<DOMRectReadOnly>({ height: 40 * ratio }),
				rootBounds: partial<DOMRectReadOnly>({ height: 600 }),
			}),
		],
		partial<IntersectionObserver>({}),
	);
}

test("on a touch screen a frame clears once the message has stood mostly in view for a moment", async () => {
	const screen = touchScreen();
	const { restore } = await open(1, (room) => [
		message(room, 1),
		message(room, 2),
		message(room, 3),
	]);
	try {
		expect(framed()).toEqual([2, 3]);
		const second = row(2);
		const third = row(3);
		if (!second || !third) throw new Error("no rows");
		await page.act(() => {
			inView(screen.watchers, second, 0.8);
			// A sliver of a message does not count.
			inView(screen.watchers, third, 0.2);
		});
		await page.act(() => settle(GLANCE_MS + 150));
		expect(framed()).toEqual([3]);
	} finally {
		restore();
		screen.undo();
	}
});

test("on a touch screen a message that leaves the view before the moment passes keeps its frame", async () => {
	const screen = touchScreen();
	const { restore } = await open(1, (room) => [
		message(room, 1),
		message(room, 2),
	]);
	try {
		const second = row(2);
		if (!second) throw new Error("no row");
		await page.act(() => {
			inView(screen.watchers, second, 1);
		});
		await page.act(() => settle(GLANCE_MS / 2));
		await page.act(() => {
			inView(screen.watchers, second, 0);
		});
		await page.act(() => settle(GLANCE_MS));
		expect(framed()).toEqual([2]);
	} finally {
		restore();
		screen.undo();
	}
});

test("a message taller than the screen clears when half of the screen shows it", async () => {
	const screen = touchScreen();
	const { restore } = await open(1, (room) => [
		message(room, 1),
		message(room, 2),
	]);
	try {
		const second = row(2);
		if (!second) throw new Error("no row");
		const watch = screen.watchers.findLast((one) => one.targets.has(second));
		if (!watch) throw new Error("not watched");
		await page.act(() => {
			watch.callback(
				[
					partial<IntersectionObserverEntry>({
						target: second,
						isIntersecting: true,
						intersectionRatio: 0.3,
						intersectionRect: partial<DOMRectReadOnly>({ height: 400 }),
						rootBounds: partial<DOMRectReadOnly>({ height: 700 }),
					}),
				],
				partial<IntersectionObserver>({}),
			);
		});
		await page.act(() => settle(GLANCE_MS + 150));
		expect(framed()).toEqual([]);
	} finally {
		restore();
		screen.undo();
	}
});
