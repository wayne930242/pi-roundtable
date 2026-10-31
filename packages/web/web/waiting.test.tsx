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
	PromptFrame,
	RoomMessage,
	RoomView,
} from "../src/api-types.ts";
import { WaitingButton } from "./components/waiting-button.tsx";
import { WaitingSheetHost } from "./components/waiting-sheet.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { currentRoute, setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import { closeWaitingList, targetShown } from "./lib/waiting.ts";
import { RoomPage } from "./pages/room.tsx";

// Rooms of this file alone: a page another file left mounted must not show (and take) their cards.
const SCOUT = "app:agent.lookout";
const GUIDE = "app:agent.pathfinder";
const THREAD = "app:thread.0b5e7c1a-0000-4000-8000-0000000000a2";
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
const said = (room: string, id: number): RoomMessage => ({
	id,
	room,
	kind: "agent",
	agent: "scout",
	author: "Scout",
	text: `message ${id}`,
	files: [],
	at: "2026-10-30T10:00:00.000Z",
});
const approval = (id: string, title: string): PromptFrame => ({
	id,
	kind: "approval",
	title,
	message: "Send the note",
	purpose: "action",
	at: new Date(Date.now() - 5 * 60_000).toISOString(),
});

/** An IntersectionObserver the tests drive: `report` says which cards the room shows. */
const observers = new Set<{
	elements: Set<Element>;
	callback: IntersectionObserverCallback;
}>();
class TestObserver {
	elements = new Set<Element>();
	constructor(public callback: IntersectionObserverCallback) {
		observers.add(this);
	}
	observe(element: Element) {
		this.elements.add(element);
	}
	disconnect() {
		observers.delete(this);
	}
}
const report = (shown: boolean) => {
	for (const observer of observers)
		observer.callback(
			[...observer.elements].map(
				(target) => ({ target, isIntersecting: shown }) as never,
			),
			observer as never,
		);
};

let page: TestPage;
const realObserver = globalThis.IntersectionObserver;
beforeAll(async () => {
	page = await openPage();
	setRouting(undefined);
	setConnection(
		partial<AppConnection>({ send: () => true, focus: () => undefined }),
	);
	Reflect.set(globalThis, "IntersectionObserver", TestObserver);
	// The lazy chunks the button and the room ask for are loaded first, so no test waits on them.
	await import("./components/waiting-chip.tsx");
	await import("./lib/waiting.ts");
});
afterAll(async () => {
	Reflect.set(globalThis, "IntersectionObserver", realObserver);
	setConnection(undefined);
	await page.unmount();
	await releaseDom();
});
/** Ends every card the store holds, this file's and any an earlier file left open. */
const closeAll = () => {
	for (const id of Object.keys(store.getState().cards))
		store.dispatch({ type: "prompt_closed", prompt: id, outcome: "approved" });
};
beforeEach(() => {
	closeAll();
	window.innerWidth = 390;
	window.location.hash = "#/rooms";
	store.dispatch({
		type: "ready",
		protocol: 1,
		principal: "ada",
		name: "Ada",
		uploads: { perMessage: 4, maxBytes: 1000 },
	} as never);
	store.dispatch({
		type: "rooms_loaded",
		rooms: [
			view(SCOUT),
			view(GUIDE),
			view(THREAD, {
				kind: "thread",
				displayName: "Check the logs",
				parent: SCOUT,
			}),
		],
	});
});
/** The card a test jumped to, let go after it so the next test starts with no jump. */
let currentTarget: string | undefined;
afterEach(async () => {
	await page.act(() => closeWaitingList());
	await page.render(null);
	closeAll();
	if (currentTarget) targetShown(currentTarget);
	currentTarget = undefined;
});
const settle = (ms = 60) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
const button = () =>
	page.container.querySelector<HTMLButtonElement>("button.waiting-button");
const open = (room: string, id: string, title: string) =>
	page.act(() =>
		store.dispatch({ type: "prompt", room, prompt: approval(id, title) }),
	);

const Chrome = () => (
	<ConfigContext.Provider value={config}>
		<WaitingButton />
		<WaitingSheetHost />
	</ConfigContext.Provider>
);

test("the button counts the open cards of every room, live, and is gone at zero", async () => {
	await page.render(<Chrome />);
	expect(button()).toBeNull();
	await open(SCOUT, "c1", "Send it?");
	await open(GUIDE, "c2", "Run it?");
	expect(button()?.textContent).toBe("2");
	expect(button()?.getAttribute("aria-label")).toBe("2 cards waiting");
	await page.act(() =>
		store.dispatch({
			type: "prompt_closed",
			prompt: "c1",
			outcome: "declined",
		}),
	);
	expect(button()?.textContent).toBe("1");
	await page.act(() =>
		store.dispatch({
			type: "prompt_closed",
			prompt: "c2",
			outcome: "approved",
		}),
	);
	expect(button()).toBeNull();
});

test("with one card the button goes straight to its room, and the room shows the card lit and focused", async () => {
	const history = spyOn(api, "messages").mockResolvedValue({
		messages: Array.from({ length: 30 }, (_, at) => said(SCOUT, at + 1)),
		more: false,
		cards: [],
	});
	try {
		await page.render(<Chrome />);
		await open(SCOUT, "c3", "Send it?");
		currentTarget = "c3";
		await page.click(button());
		await page.act(() => settle());
		expect(currentRoute()).toEqual({ pane: "room", key: SCOUT });
		expect(document.querySelector("dialog[open]")).toBeNull();
		await page.render(
			<ConfigContext.Provider value={config}>
				<RoomPage roomKey={SCOUT} />
			</ConfigContext.Provider>,
		);
		await page.act(() => settle(120));
		const slot = page.container.querySelector<HTMLElement>('[data-card="c3"]');
		expect(slot?.hasAttribute("data-lit")).toBe(true);
		expect(document.activeElement).toBe(slot?.querySelector(".prompt") ?? null);
	} finally {
		history.mockRestore();
	}
});

test("with several cards the button opens a list of them, and a row goes to its card, a dispatch thread's too", async () => {
	await page.render(<Chrome />);
	await open(SCOUT, "c4", "Send it?");
	await open(THREAD, "c5", "Run the check?");
	await page.click(button());
	await page.act(() => settle());
	const rows = [
		...document.querySelectorAll<HTMLButtonElement>(".waiting-list button"),
	];
	expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual([
		"Send it?",
		"Run the check?",
	]);
	expect(rows[1]?.textContent).toContain("lookout › Check the logs");
	expect(rows[1]?.textContent).toMatch(/· \d+ min ago$/);
	currentTarget = "c5";
	await page.click(rows[1] ?? null);
	await page.act(() => settle(300));
	expect(currentRoute()).toEqual({ pane: "room", key: THREAD });
	expect(document.querySelector("dialog[open]")).toBeNull();
});

test("in a room a waiting card out of view shows a chip that brings it back", async () => {
	const history = spyOn(api, "messages").mockResolvedValue({
		messages: [said(GUIDE, 1), said(GUIDE, 2)],
		more: false,
		cards: [],
	});
	try {
		await open(GUIDE, "c6", "Send it?");
		await page.render(
			<ConfigContext.Provider value={config}>
				<RoomPage roomKey={GUIDE} />
			</ConfigContext.Provider>,
		);
		await page.act(() => settle(120));
		const chip = () =>
			page.container.querySelector<HTMLButtonElement>("button.waiting-chip");
		await page.act(() => report(true));
		expect(chip()).toBeNull();
		await page.act(() => report(false));
		expect(chip()?.textContent).toBe("1 card waiting for an answer");
		await page.click(chip());
		const slot = page.container.querySelector<HTMLElement>('[data-card="c6"]');
		expect(slot?.hasAttribute("data-lit")).toBe(true);
		await page.act(() => report(true));
		expect(chip()).toBeNull();
		// Answered, the room has no card waiting and the chip goes with it.
		await page.act(() => report(false));
		await page.act(() =>
			store.dispatch({
				type: "prompt_closed",
				prompt: "c6",
				outcome: "approved",
			}),
		);
		expect(chip()).toBeNull();
	} finally {
		history.mockRestore();
	}
});
