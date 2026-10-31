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
import type { ConfigView, RoomView } from "../src/api-types.ts";
import { CouncilView } from "./components/council-view.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { resetCouncilChoice } from "./lib/council.ts";
import {
	COUNCIL_MODE_KEY,
	councilModeOf,
	OLD_ROOM_TOGGLE_KEY,
	OLD_TABLE_MODE_KEY,
	resetCouncilModes,
	setCouncilMode,
} from "./lib/council-mode.ts";
import { loadKit } from "./lib/kit.ts";
import { setLook } from "./lib/look.ts";
import { setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import { TABLE_PAGE_CSS } from "./lib/table-page-style.ts";
import { RoomPage } from "./pages/room.tsx";
import { TablePage } from "./pages/table.tsx";

const CREW = "app:group.crew";
const config: ConfigView = {
	title: "Console",
	panes: ["rooms", "table"],
	timeZone: "UTC",
	look: "modern",
};

const agent = (name: string): RoomView => ({
	key: `app:agent.${name}`,
	kind: "agent",
	name,
	displayName: name,
	home: name === "guide",
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
});

const crew: RoomView = {
	key: CREW,
	kind: "group",
	name: "crew",
	displayName: "Crew",
	home: false,
	readOnly: false,
	members: ["guide", "scout"],
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
};

let page: TestPage;
let messages: ReturnType<typeof spyOn>;
const realMatchMedia = globalThis.matchMedia;
const said: Array<{ room: string; text: string }> = [];
/** The screen is a phone's, 390 px wide. */
let phone = false;

beforeAll(async () => {
	await loadKit();
	// The chunks the views ask for load first, so no test depends on the clock.
	await import("./components/council-view.tsx");
	await import("./components/council-sheet.tsx");
	page = await openPage();
	setRouting(undefined);
	window.matchMedia = ((query: string) => ({
		matches: phone && query.includes("max-width: 719px"),
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
	said.length = 0;
	phone = false;
	window.localStorage.clear();
	// The look another file left would draw the Camelot strip over the chat.
	setLook("modern");
	resetCouncilModes();
	resetCouncilChoice();
	setConnection(
		partial<AppConnection>({
			send: () => true,
			focus: () => undefined,
			say: (room: string, text: string) => {
				said.push({ room, text });
				return true;
			},
		}),
	);
	messages = spyOn(api, "messages").mockResolvedValue({
		messages: [],
		more: false,
		cards: [],
	});
	store.dispatch({
		type: "rooms_loaded",
		rooms: [agent("guide"), agent("scout"), crew],
	});
});
afterEach(async () => {
	messages.mockRestore();
	await page.render(null);
	store.dispatch({ type: "rooms_loaded", rooms: [] });
	window.location.hash = "";
	// The next file finds no mode chosen.
	window.localStorage.clear();
	resetCouncilModes();
	setLook(undefined);
});

const settle = (ms = 80) =>
	page.act(() => new Promise((done) => setTimeout(done, ms)));
const q = <T extends Element>(selector: string): T | null =>
	document.querySelector<T>(selector);
const all = <T extends Element>(selector: string): T[] => [
	...document.querySelectorAll<T>(selector),
];
const radio = (mode: string) =>
	all<HTMLInputElement>('.table-mode input[type="radio"]').find(
		(one) => one.value === mode,
	) ?? null;
/** The council's own controls in the header, by what they say. */
const controls = () =>
	all<HTMLElement>(
		".council-head .table-tools > *, .council-head > button:not(.room-picture)",
	)
		.map((one) =>
			one.matches("fieldset")
				? [...one.querySelectorAll("label")].map((l) => l.textContent).join("/")
				: (one.getAttribute("aria-label") ?? one.textContent),
		)
		.filter(Boolean);

const room = async () => {
	window.location.hash = `#/room/${CREW}`;
	await page.render(
		<ConfigContext.Provider value={config}>
			<RoomPage roomKey={CREW} />
		</ConfigContext.Provider>,
	);
	await settle();
};
const table = async () => {
	window.location.hash = "#/table/crew";
	await page.render(
		<ConfigContext.Provider value={config}>
			<TablePage focus="crew" />
		</ConfigContext.Provider>,
	);
	await settle();
};

test("the group room and the round table show the same council view with the same controls", async () => {
	await room();
	expect(q(".council-head")).not.toBeNull();
	const inRoom = controls();
	expect(inRoom).toEqual(
		expect.arrayContaining([
			"Animation mode/Chat mode",
			"Council: Crew ▾",
			"Room menu",
		]),
	);
	// The room keeps its own way back and its name before them.
	expect(q(".council-head .room-name")?.textContent).toBe("Crew");
	await table();
	expect(q(".council-head")).not.toBeNull();
	expect(controls()).toEqual(inRoom);
	expect(q(".council-head h1")?.textContent).toBe("Round table");
});

test("a mode chosen in one entry shows in the other", async () => {
	await room();
	expect(radio("scene")?.checked).toBe(true);
	expect(q(".room-scene")).not.toBeNull();
	await page.click(radio("chat"));
	await settle();
	expect(q(".table-chat")).not.toBeNull();
	await table();
	expect(radio("chat")?.checked).toBe(true);
	expect(q(".table-chat")).not.toBeNull();
	await page.click(radio("scene"));
	await settle();
	await room();
	expect(radio("scene")?.checked).toBe(true);
	expect(q(".room-scene")).not.toBeNull();
	expect(localStorage.getItem(COUNCIL_MODE_KEY(CREW))).toBe("scene");
});

test("a council read first takes the room's old toggle, else the table page's old mode, and the room's old key goes", () => {
	localStorage.setItem(OLD_ROOM_TOGGLE_KEY(CREW), "0");
	localStorage.setItem(OLD_TABLE_MODE_KEY, "scene");
	expect(councilModeOf(CREW)).toBe("chat");
	expect(localStorage.getItem(COUNCIL_MODE_KEY(CREW))).toBe("chat");
	expect(localStorage.getItem(OLD_ROOM_TOGGLE_KEY(CREW))).toBeNull();
	localStorage.setItem(OLD_ROOM_TOGGLE_KEY("app:group.ops"), "1");
	localStorage.setItem(OLD_TABLE_MODE_KEY, "chat");
	expect(councilModeOf("app:group.ops")).toBe("scene");
	// No toggle for the room: the device's old table mode.
	expect(councilModeOf("app:group.new")).toBe("chat");
	expect(localStorage.getItem(COUNCIL_MODE_KEY("app:group.new"))).toBe("chat");
	// What was chosen since wins over both, after a reload too.
	setCouncilMode(CREW, "scene");
	localStorage.setItem(OLD_ROOM_TOGGLE_KEY(CREW), "0");
	resetCouncilModes();
	expect(councilModeOf(CREW)).toBe("scene");
	// Nothing kept anywhere: the scene.
	localStorage.clear();
	resetCouncilModes();
	expect(councilModeOf(CREW)).toBe("scene");
	expect(localStorage.getItem(COUNCIL_MODE_KEY(CREW))).toBeNull();
});

test("at 390 px the council's tools take their own row, and a send closes the keyboard in both modes", async () => {
	phone = true;
	window.innerWidth = 390;
	const send = async (text: string) => {
		const box = q<HTMLTextAreaElement>("textarea");
		if (!box) throw new Error("no composer");
		await page.act(() => {
			box.focus();
			Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)?.set?.call(box, text);
			box.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await page.click(q("button.composer-send"));
		await settle(30);
		return box;
	};
	await page.render(
		<ConfigContext.Provider value={config}>
			<section className="room">
				<CouncilView roomKey={CREW} lead={<h1>Crew</h1>} />
			</section>
		</ConfigContext.Provider>,
	);
	await settle();
	const narrow = TABLE_PAGE_CSS.slice(
		TABLE_PAGE_CSS.indexOf("@media (max-width: 719px)"),
	);
	expect(narrow).toContain(".council-head .table-tools {\n\t\torder: 3;");
	expect(q(".council-head .table-tools .council-chip")).not.toBeNull();
	expect(q(".council-head .table-tools .table-mode")).not.toBeNull();
	let box = await send("from the scene");
	expect(said.at(-1)).toEqual({ room: CREW, text: "from the scene" });
	expect(document.activeElement).not.toBe(box);
	await page.click(radio("chat"));
	await settle();
	box = await send("from the chat");
	expect(said.at(-1)).toEqual({ room: CREW, text: "from the chat" });
	expect(document.activeElement).not.toBe(box);
	// A wide screen keeps the focus for the next message.
	phone = false;
	await page.render(null);
	await page.render(
		<ConfigContext.Provider value={config}>
			<section className="room">
				<CouncilView roomKey={CREW} lead={<h1>Crew</h1>} />
			</section>
		</ConfigContext.Provider>,
	);
	await settle();
	box = await send("on a desk");
	expect(document.activeElement).toBe(box);
});
