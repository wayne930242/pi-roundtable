import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import type { ConfigView, RoomView } from "../src/api-types.ts";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
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
beforeAll(async () => {
	page = await openPage();
	setRouting(undefined);
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});
afterEach(async () => {
	await page.act(() => store.dispatch({ type: "rooms_loaded", rooms: [] }));
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

async function show() {
	await page.render(
		<ConfigContext.Provider value={config}>
			<RoomsPage onSearch={() => undefined} />
		</ConfigContext.Provider>,
	);
	await page.act(() =>
		store.dispatch({
			type: "rooms_loaded",
			rooms: [
				view(GUIDE, { home: true, displayName: "Guide" }),
				thread(RUNNING, "Check the disk"),
				thread(DONE, "Fix the build", { closed: true }),
				thread(OLD, "Earlier job", { closed: true }),
			],
		}),
	);
}

const text = () => page.container.textContent ?? "";
const buttons = () =>
	[...page.container.querySelectorAll<HTMLElement>(".thread-dismiss")].map(
		(one) => one.getAttribute("aria-label"),
	);

test("only a finished thread has a remove button, named for the thread", async () => {
	await show();
	expect(buttons()).toEqual(["Remove Fix the build", "Remove Earlier job"]);
	// The open thread has none, so there is nothing to press on a running dispatch.
	expect(text()).toContain("Check the disk");
});

test("pressing a finished thread's remove button takes it off the list and tells the server", async () => {
	const send = spyOn(api, "dismissThread").mockResolvedValue({ dismissed: 1 });
	await show();
	await page.act(async () => {
		page.container
			.querySelector<HTMLElement>('[aria-label="Remove Earlier job"]')
			?.click();
		await settle();
	});
	expect(send).toHaveBeenCalledWith(OLD);
	expect(text()).not.toContain("Earlier job");
	expect(text()).toContain("Fix the build");
	expect(text()).toContain("Check the disk");
	send.mockRestore();
});

test("Clear all takes every finished thread of the room off the list and leaves the open one", async () => {
	const send = spyOn(api, "dismissThreads").mockResolvedValue({ dismissed: 2 });
	await show();
	const clear = [...page.container.querySelectorAll("button")].find(
		(one) => one.textContent === "Clear all",
	);
	expect(clear).toBeDefined();
	await page.act(async () => {
		clear?.click();
		await settle();
	});
	expect(send).toHaveBeenCalledWith(GUIDE);
	expect(text()).not.toContain("Fix the build");
	expect(text()).not.toContain("Earlier job");
	expect(text()).toContain("Check the disk");
	expect(buttons()).toEqual([]);
	send.mockRestore();
});

test("a refused dismissal leaves the thread listed and asks the server for the list again", async () => {
	const send = spyOn(api, "dismissThread").mockRejectedValue(
		new Error("The thread is still open."),
	);
	await show();
	const before = store.getState().revision;
	await page.act(async () => {
		page.container
			.querySelector<HTMLElement>('[aria-label="Remove Fix the build"]')
			?.click();
		await settle();
	});
	expect(text()).toContain("Fix the build");
	expect(store.getState().revision).toBeGreaterThan(before);
	send.mockRestore();
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
