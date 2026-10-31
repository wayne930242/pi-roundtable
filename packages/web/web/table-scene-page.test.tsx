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
import { DialogueBox } from "./components/dialogue-box.tsx";
import { GroupScene } from "./components/group-scene.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { clearDrafts, draftOf } from "./lib/drafts.ts";
import { loadKit } from "./lib/kit.ts";
import { setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import {
	resetTableModes,
	setTableMode,
	tableModeOf,
} from "./lib/table-mode.ts";
import { DIALOGUE_FOLD_CSS } from "./lib/table-page-style.ts";
import {
	DIALOGUE_FOLDED_KEY,
	resetTableView,
	setDialogueFolded,
} from "./lib/table-view.ts";

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

/** Lets the box's own timers run out; there is no wait for the camera any more, the council's box is up at once. */
const arrive = () => settle(30);

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
		rooms: [agent("lena", "Lena"), agent("otto", "\u6885\u68ee")],
	});
	for (const [room, who, author, text] of [
		[SCOUT, "lena", "Lena", "Found **three** leads."],
		[MASON, "otto", "\u6885\u68ee", "\u7246\u5df2\u7d93\u780c\u597d\u4e86。"],
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
	localStorage.removeItem(DIALOGUE_FOLDED_KEY);
	resetTableView();
});

const settle = (ms = 80) =>
	page.act(() => new Promise((done) => setTimeout(done, ms)));
const query = <T extends Element>(selector: string): T | null =>
	page.container.querySelector<T>(selector);

/** The box on an agent's room, as the scene's dialogue box is built: open, over a table. */
const render = (room: string) =>
	page.render(
		<ConfigContext.Provider value={config}>
			<DialogueBox roomKey={room} open />
		</ConfigContext.Provider>,
	);

const NOVA = "app:agent.nova";

test("the box on an agent's room names that agent on the plate and shows its newest line", async () => {
	await render(SCOUT);
	await settle();
	const box = query(".scene-box");
	expect(box).not.toBeNull();
	expect(box?.querySelector(".scene-name")?.textContent).toBe("Lena");
	expect(box?.textContent).toContain("Found");
	// the room's own composer is under it
	expect(box?.querySelector("textarea")).not.toBeNull();
	await render(MASON);
	await settle();
	expect(query(".scene-name")?.textContent).toBe("\u6885\u68ee");
});

test("an agent's room keeps that agent's name on the plate and in the progress line while the newest line is the owner's", async () => {
	store.dispatch({
		type: "rooms_loaded",
		rooms: [
			agent("lena", "Lena"),
			agent("otto", "\u6885\u68ee"),
			agent("nova", "Nova"),
		],
	});
	store.dispatch({
		type: "message",
		room: NOVA,
		message: {
			id: 2,
			room: NOVA,
			kind: "owner",
			author: "Ada",
			text: "stream",
			files: [],
			at: "2026-10-29T10:01:00.000Z",
		},
	});
	await page.act(() =>
		store.dispatch({
			type: "activity",
			room: NOVA,
			typing: true,
			stoppable: true,
		}),
	);
	await render(NOVA);
	await arrive();
	expect(query(".scene-name")?.textContent).toBe("Nova");
	expect(query(".scene-chip")).not.toBeNull();
	// the owner's words stay, marked as theirs
	expect(query(".scene-from")?.textContent).toBe("Ada");
	expect(query(".scene-line")?.textContent).toContain("stream");
	expect(query(".scene-box")?.textContent).toContain("Nova");
	expect(query(".scene-box")?.textContent).not.toContain("Ada is");
});

/** Frames and a clock the test turns by hand, so the typing can be watched half way and `act` has no chain of frames to wait out. */
function manualFrames() {
	const realFrame = window.requestAnimationFrame;
	const realCancel = window.cancelAnimationFrame;
	const realNow = performance.now.bind(performance);
	// a whole number, so that adding to it and subtracting it again gives back exactly what was added
	let clock = Math.ceil(realNow());
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
		await render(SCOUT);
		await arrive();
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
	await render(SCOUT);
	await settle(30);
	expect(query(".scene-line")?.textContent).toContain("Found three leads.");
	expect(query(".scene-line")?.getAttribute("role")).toBeNull();
});

test("a card that waits shows in the box, and answering it there answers the room's card", async () => {
	await render(SCOUT);
	await arrive();
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
	await render(SCOUT);
	await arrive();
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
	await render(MASON);
	await settle(30);
	expect(query<HTMLTextAreaElement>(".scene-box textarea")?.value).toBe("");
	await type("\u7246\u8981\u518d\u9ad8\u4e00\u9ede");
	expect(draftOf(MASON)).toBe("\u7246\u8981\u518d\u9ad8\u4e00\u9ede");
	await render(SCOUT);
	await settle(30);
	expect(query<HTMLTextAreaElement>(".scene-box textarea")?.value).toBe(
		"remember the milk",
	);
});

test("the Log button opens the room's whole message list over the scene", async () => {
	await render(SCOUT);
	await arrive();
	const open = query<HTMLButtonElement>(".scene-log-button");
	await page.click(open);
	await settle(40);
	expect(query(".scene-log .messages")?.textContent).toContain(
		"Found three leads.",
	);
});

test("the box's last button folds it, labelled, and the folded box is one bar that a tap opens again; the choice stays on the device", async () => {
	await render(SCOUT);
	await arrive();
	const toggle = () => query<HTMLButtonElement>(".scene-collapse");
	const shape = (button: Element | null) =>
		button?.querySelector("path")?.getAttribute("d");
	const turn = () => toggle()?.querySelector("svg")?.style.rotate;
	// A chevron with words beside it, not the dots of More.
	expect(shape(toggle())).toBe("M9 6l6 6-6 6");
	expect(shape(toggle())).not.toBe(shape(query(".scene-more")));
	expect(toggle()?.textContent).toBe("Collapse dialogue");
	expect(turn()).toBe("90deg");
	expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
	expect(query(".scene-bar")).toBeNull();
	await page.click(toggle());
	const box = query(".scene-box");
	expect(box?.hasAttribute("data-collapsed")).toBe(true);
	// Folded, nothing but the bar shows: no tab, no line, no strip; the composer keeps its text out of sight.
	expect(query(".scene-tab")).toBeNull();
	expect(query(".scene-body")).toBeNull();
	expect(query(".order-strip")).toBeNull();
	expect(query<HTMLElement>(".scene-composer")?.hidden).toBe(true);
	const bar = query(".scene-bar");
	expect(bar?.querySelector(".scene-bar-name")?.textContent).toBe("Lena");
	expect(bar?.querySelector(".scene-bar-preview")?.textContent).toBe(
		"Found three leads.",
	);
	// The button on the bar says it opens the box, and the chevron turns.
	expect(toggle()?.closest(".scene-bar")).toBe(bar);
	expect(toggle()?.textContent).toBe("Expand dialogue");
	expect(turn()).toBe("-90deg");
	expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
	expect(localStorage.getItem(DIALOGUE_FOLDED_KEY)).toBe("1");
	// A page that comes back to it finds it folded.
	resetTableView();
	await page.render(null);
	await render(SCOUT);
	await arrive();
	expect(query(".scene-bar")).not.toBeNull();
	// A tap anywhere on the bar opens the box.
	await page.click(query(".scene-bar-preview"));
	expect(query(".scene-bar")).toBeNull();
	expect(query(".scene-box")?.hasAttribute("data-collapsed")).toBe(false);
	expect(query(".scene-body")).not.toBeNull();
	expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
	expect(localStorage.getItem(DIALOGUE_FOLDED_KEY)).toBe("0");
	// The bar's own button opens it too, once.
	await page.click(toggle());
	await page.click(toggle());
	expect(query(".scene-bar")).toBeNull();
});

test("on an upright phone a folded box gives the scene its height: the frame says so, and the box's row is only as tall as the bar", async () => {
	setDialogueFolded(true);
	store.dispatch({
		type: "rooms_loaded",
		rooms: [agent("lena", "Lena"), agent("otto", "\u6885\u68ee"), crew()],
	});
	await page.render(
		<ConfigContext.Provider value={config}>
			<GroupScene roomKey={CREW} members={["lena", "otto"]} />
		</ConfigContext.Provider>,
	);
	await arrive();
	expect(query(".room-scene")?.hasAttribute("data-folded")).toBe(true);
	const portrait = DIALOGUE_FOLD_CSS.slice(
		DIALOGUE_FOLD_CSS.indexOf(
			"@media (max-width: 719px) and (orientation: portrait)",
		),
	);
	expect(portrait).toContain(
		".table-frame[data-focused][data-folded] {\n\t\tgrid-template-rows: minmax(0, 1fr) auto;",
	);
	await page.click(query(".scene-collapse"));
	expect(query(".room-scene")?.hasAttribute("data-folded")).toBe(false);
});

const CREW = "app:group.crew";

const crew = (): RoomView => ({
	key: CREW,
	kind: "group",
	name: "crew",
	displayName: "Crew",
	home: false,
	readOnly: false,
	members: ["lena", "otto"],
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
});

const heard = (
	id: number,
	who: "owner" | "lena" | "otto",
	text: string,
): RoomMessage => ({
	id,
	room: CREW,
	kind: who === "owner" ? "owner" : "agent",
	...(who === "owner" ? {} : { agent: who }),
	author: who === "owner" ? "Ada" : who === "lena" ? "Lena" : "\u6885\u68ee",
	text,
	files: [],
	at: "2026-10-29T10:00:00.000Z",
});

/** Ids that keep rising across the tests, because the store keeps the room's messages between them. */
let seq = 10;
const nid = () => ++seq;

const say = (...messages: RoomMessage[]) =>
	store.dispatch({
		type: "history_loaded",
		room: CREW,
		messages,
		more: false,
		older: false,
	});

const lit = () =>
	[...page.container.querySelectorAll("g.seat[data-focus]")].map(
		(seat) => seat.getAttribute("aria-label")?.split(" ")[0],
	);

test("a group scene turns the camera to whoever speaks, and rests on the whole ring while the owner does", async () => {
	store.dispatch({
		type: "rooms_loaded",
		rooms: [agent("lena", "Lena"), agent("otto", "\u6885\u68ee"), crew()],
	});
	say(heard(nid(), "owner", "Who has the plan?"));
	await page.render(
		<ConfigContext.Provider value={config}>
			<GroupScene roomKey={CREW} members={["lena", "otto"]} />
		</ConfigContext.Provider>,
	);
	await arrive();
	// the owner's line shows under the owner's name, and the camera is on the whole ring
	expect(query(".scene-name")?.textContent).toBe("Ada");
	expect(lit()).toEqual([]);
	expect(query(".scene-box")?.hasAttribute("data-open")).toBe(true);
	await page.act(() =>
		say(heard(nid(), "otto", "\u7246\u5df2\u7d93\u780c\u597d\u4e86。")),
	);
	expect(lit()).toEqual(["\u6885\u68ee"]);
	expect(query(".scene-name")?.textContent).toBe("\u6885\u68ee");
	await page.act(() => say(heard(nid(), "lena", "Then I take the roof.")));
	expect(lit()).toEqual(["Lena"]);
	await page.act(() => say(heard(nid(), "owner", "Thanks both.")));
	expect(lit()).toEqual([]);
	expect(query(".scene-name")?.textContent).toBe("Ada");
});

test("a seat the person taps turns the camera there until the next line comes", async () => {
	store.dispatch({
		type: "rooms_loaded",
		rooms: [agent("lena", "Lena"), agent("otto", "\u6885\u68ee"), crew()],
	});
	say(heard(nid(), "lena", "I am here."));
	await page.render(
		<ConfigContext.Provider value={config}>
			<GroupScene roomKey={CREW} members={["lena", "otto"]} />
		</ConfigContext.Provider>,
	);
	await settle(160);
	expect(lit()).toEqual(["Lena"]);
	const otto = page.container.querySelector<SVGGElement>(
		'g.seat[aria-label^="\u6885\u68ee"]',
	);
	await page.act(() => {
		otto?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	expect(lit()).toEqual(["\u6885\u68ee"]);
	await page.act(() => say(heard(nid(), "lena", "Back to me.")));
	expect(lit()).toEqual(["Lena"]);
});

test("a speaker change while the owner is typing does not take the focus from the message box", async () => {
	store.dispatch({
		type: "rooms_loaded",
		rooms: [agent("lena", "Lena"), agent("otto", "\u6885\u68ee"), crew()],
	});
	say(heard(nid(), "lena", "First."));
	await page.render(
		<ConfigContext.Provider value={config}>
			<GroupScene roomKey={CREW} members={["lena", "otto"]} />
		</ConfigContext.Provider>,
	);
	await settle(160);
	const box = query<HTMLTextAreaElement>(".scene-box textarea");
	box?.focus();
	expect(document.activeElement).toBe(box);
	await page.act(() => say(heard(nid(), "otto", "Second.")));
	expect(lit()).toEqual(["\u6885\u68ee"]);
	expect(document.activeElement).toBe(query(".scene-box textarea"));
	expect(query<HTMLTextAreaElement>(".scene-box textarea")).toBe(box);
});

test("a room's choice of the scene is remembered for that room", () => {
	resetTableModes();
	expect(tableModeOf(CREW)).toBe(false);
	setTableMode(CREW, true);
	expect(tableModeOf(CREW)).toBe(true);
	expect(tableModeOf("app:group.other")).toBe(false);
	// a page that starts again reads it back from the browser's storage
	resetTableModes();
	expect(tableModeOf(CREW)).toBe(true);
	setTableMode(CREW, false);
	resetTableModes();
	expect(tableModeOf(CREW)).toBe(false);
});
