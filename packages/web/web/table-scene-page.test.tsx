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
	ClientFrame,
	ConfigView,
	RoomMessage,
	RoomView,
} from "../src/api-types.ts";
import { ConfigContext } from "./components/../lib/config.ts";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { clearDrafts, draftOf } from "./lib/drafts.ts";
import { loadKit } from "./lib/kit.ts";
import { setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import { TablePage } from "./pages/table.tsx";

const SCOUT = "app:agent.lena";
const MASON = "app:agent.otto";

const config: ConfigView = {
	title: "Console",
	panes: ["table"],
	timeZone: "UTC",
	look: "modern",
};

const agent = (name: string, displayName = name): RoomView => ({
	key: `app:agent.${name}`,
	kind: "agent",
	name,
	displayName,
	home: false,
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
});

const reply = (
	id: number,
	room: string,
	who: string,
	author: string,
	text: string,
): RoomMessage => ({
	id,
	room,
	kind: "agent",
	agent: who,
	author,
	text,
	files: [],
	at: "2026-10-29T10:00:00.000Z",
});

const sent: ClientFrame[] = [];
let page: TestPage;
let reduced = false;
const realMatchMedia = globalThis.matchMedia;

beforeAll(async () => {
	await loadKit();
	page = await openPage();
	setRouting(undefined);
	window.matchMedia = ((query: string) => ({
		matches: query.includes("prefers-reduced-motion") ? reduced : false,
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

let fetched: ReturnType<typeof spyOn>;
beforeEach(() => {
	// every test sets its own: another file of the same run may have put a different one in place
	setConnection(
		partial<AppConnection>({
			send: (frame: ClientFrame) => {
				sent.push(frame);
				return true;
			},
			focus: (room?: string) => store.dispatch({ type: "focused", room }),
			say: () => undefined,
		}),
	);
	sent.length = 0;
	reduced = false;
	window.location.hash = "#/table";
	store.dispatch({
		type: "rooms_loaded",
		rooms: [agent("lena", "Lena"), agent("otto", "梅森")],
	});
	for (const [room, who, author, text] of [
		[SCOUT, "lena", "Lena", "Found **three** leads."],
		[MASON, "otto", "梅森", "牆已經砌好了。"],
	] as const)
		store.dispatch({
			type: "history_loaded",
			room,
			messages: [reply(1, room, who, author, text)],
			more: false,
			older: false,
		});
	fetched = spyOn(api, "messages").mockImplementation(async (room) => ({
		messages: store.getState().rooms[room]?.messages ?? [],
		more: false,
		cards: [],
	}));
});
afterEach(async () => {
	fetched.mockRestore();
	await page.render(null);
	store.dispatch({ type: "rooms_loaded", rooms: [] });
	clearDrafts();
});

const settle = (ms = 80) =>
	page.act(() => new Promise((done) => setTimeout(done, ms)));
const query = <T extends Element>(selector: string): T | null =>
	page.container.querySelector<T>(selector);

const render = (focus?: string) =>
	page.render(
		<ConfigContext.Provider value={config}>
			<TablePage focus={focus} />
		</ConfigContext.Provider>,
	);

test("the overview has no dialogue box, and an address that names an agent opens the box on that agent's room", async () => {
	await render();
	await settle();
	expect(query(".scene-box")).toBeNull();
	await render("lena");
	await settle();
	const box = query(".scene-box");
	expect(box).not.toBeNull();
	expect(box?.querySelector(".scene-name")?.textContent).toBe("Lena");
	expect(box?.textContent).toContain("Found");
	// the room's own composer is under it
	expect(box?.querySelector("textarea")).not.toBeNull();
});

test("the key of a room opens the same view as the agent's name", async () => {
	await render(MASON);
	await settle();
	expect(query(".scene-box")).not.toBeNull();
	expect(query(".scene-name")?.textContent).toBe("梅森");
});

test("an address that names nobody seated goes back to the whole ring in place, adding no history entry", async () => {
	window.location.hash = "#/table/ghost";
	const before = window.history.length;
	await render("ghost");
	await settle();
	expect(window.location.hash).toBe("#/table");
	expect(window.history.length).toBe(before);
	expect(query(".scene-box")).toBeNull();
});

test("the box slides up after the camera has turned, at once under reduced motion", async () => {
	await render("lena");
	expect(query(".scene-box")?.hasAttribute("data-open")).toBe(false);
	await settle(380);
	expect(query(".scene-box")?.hasAttribute("data-open")).toBe(true);
	await render();
	reduced = true;
	await render("otto");
	await settle(20);
	expect(query(".scene-box")?.hasAttribute("data-open")).toBe(true);
});

/** Frames and a clock the test turns by hand, so the typing can be watched half way and `act` has no chain of frames to wait out. */
function manualFrames() {
	const realFrame = window.requestAnimationFrame;
	const realCancel = window.cancelAnimationFrame;
	const realNow = performance.now.bind(performance);
	let clock = realNow();
	let next = 1;
	const queue = new Map<number, FrameRequestCallback>();
	window.requestAnimationFrame = (callback) => {
		queue.set(next, callback);
		return next++;
	};
	window.cancelAnimationFrame = (id) => void queue.delete(id);
	performance.now = () => clock;
	return {
		/** Moves the clock on by `ms` and runs the frames asked for so far. */
		async advance(ms: number) {
			clock += ms;
			const due = [...queue.entries()];
			queue.clear();
			await page.act(() => {
				for (const [, callback] of due) callback(clock);
			});
		},
		restore() {
			window.requestAnimationFrame = realFrame;
			window.cancelAnimationFrame = realCancel;
			performance.now = realNow;
		},
	};
}

test("a streaming reply types out, and a tap on it shows the whole text", async () => {
	const frames = manualFrames();
	try {
		await render("lena");
		await settle(380);
		const words =
			`Streaming along nicely ${"with a fairly long sentence ".repeat(30)}`.trim();
		await page.act(() => {
			store.dispatch({
				type: "activity",
				room: SCOUT,
				typing: true,
				stoppable: true,
			});
			store.dispatch({
				type: "progress",
				room: SCOUT,
				event: { type: "text", delta: words },
			});
		});
		await frames.advance(100);
		const early = query(".scene-line")?.textContent ?? "";
		// nine characters in a tenth of a second at 90 a second
		expect(early).toBe(words.slice(0, 9));
		await frames.advance(1000);
		const later = query(".scene-line")?.textContent ?? "";
		expect(later.length).toBeGreaterThan(early.length);
		expect(later.length).toBeLessThan(words.length / 2);
		const line = query<HTMLElement>(".scene-line");
		expect(line?.getAttribute("role")).toBe("button");
		await page.click(line);
		expect(query(".scene-line")?.textContent).toBe(words);
		// all of it shows, so there is nothing left to tap
		expect(query(".scene-line")?.getAttribute("role")).toBeNull();
	} finally {
		frames.restore();
	}
});

test("under reduced motion the whole text shows at once", async () => {
	reduced = true;
	await render("lena");
	await settle(30);
	expect(query(".scene-line")?.textContent).toContain("Found three leads.");
	expect(query(".scene-line")?.getAttribute("role")).toBeNull();
});

test("a card that waits shows in the box, and answering it there answers the room's card", async () => {
	await render("lena");
	await settle(380);
	await page.act(() => {
		store.dispatch({
			type: "prompt",
			room: SCOUT,
			prompt: {
				id: "p1",
				kind: "approval",
				title: "Run the deploy?",
				message: "Deploy it.",
				purpose: "action",
			},
		});
	});
	await settle(30);
	const card = query(".scene-card");
	expect(card?.textContent).toContain("Run the deploy?");
	const approve = [...(card?.querySelectorAll("button") ?? [])].find(
		(button) => button.textContent === "Approve",
	);
	expect(approve).toBeDefined();
	await page.click(approve ?? null);
	expect(sent).toContainEqual({
		type: "approval",
		prompt: "p1",
		approved: true,
	});
});

test("each room keeps what was typed and not sent while the table turns to another agent", async () => {
	await render("lena");
	await settle(380);
	const type = async (value: string) => {
		const box = query<HTMLTextAreaElement>(".scene-box textarea");
		await page.act(() => {
			if (!box) return;
			const setter = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)?.set;
			setter?.call(box, value);
			box.dispatchEvent(new Event("input", { bubbles: true }));
		});
	};
	await type("remember the milk");
	expect(draftOf(SCOUT)).toBe("remember the milk");
	await render("otto");
	await settle(30);
	expect(query<HTMLTextAreaElement>(".scene-box textarea")?.value).toBe("");
	await type("牆要再高一點");
	expect(draftOf(MASON)).toBe("牆要再高一點");
	await render("lena");
	await settle(30);
	expect(query<HTMLTextAreaElement>(".scene-box textarea")?.value).toBe(
		"remember the milk",
	);
});

test("the Log button opens the room's whole message list over the scene", async () => {
	await render("lena");
	await settle(380);
	const open = query<HTMLButtonElement>(".scene-log-button");
	await page.click(open);
	await settle(40);
	expect(query(".scene-log .messages")?.textContent).toContain(
		"Found three leads.",
	);
});
