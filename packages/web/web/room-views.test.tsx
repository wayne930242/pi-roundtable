// Every view of a room shows the same parts of it: the chat and the scene's dialogue box lay a room
// out differently, but each shows its messages, its own cards, the cards carried up from a thread
// under it, and the composer. A view that drops one fails here, whichever entry shows it.

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
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { resetCouncilChoice } from "./lib/council.ts";
import { resetCouncilModes, setCouncilMode } from "./lib/council-mode.ts";
import { loadKit } from "./lib/kit.ts";
import { setLook } from "./lib/look.ts";
import { hrefFor, setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import { setDialogueFolded } from "./lib/table-view.ts";
import { RoomPage } from "./pages/room.tsx";
import { TablePage } from "./pages/table.tsx";

// Keys no other file uses: the store outlives each file, and another file's messages in a room would be its newest line.
const CREW = "app:group.views";
const THREAD = "app:thread.0b5e7c1a-0000-4000-8000-0000000000f1";
const config: ConfigView = {
	title: "Console",
	panes: ["rooms", "table"],
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

const ROOMS: RoomView[] = [
	view("app:agent.guide", { home: true }),
	view("app:agent.scout"),
	view(CREW, {
		kind: "group",
		displayName: "Views",
		members: ["guide", "scout"],
	}),
	view(THREAD, {
		kind: "thread",
		displayName: "Coding #12",
		parent: CREW,
		readOnly: true,
	}),
];

const REPLY: RoomMessage = {
	id: 1,
	room: CREW,
	kind: "agent",
	agent: "scout",
	author: "scout",
	text: "Started Coding #12.",
	files: [],
	at: "2026-11-02T10:00:00.000Z",
};

const approval = (id: string, title: string): PromptFrame => ({
	id,
	at: "2026-11-02T10:01:00.000Z",
	kind: "approval",
	title,
	message: "",
	purpose: "action",
});

let page: TestPage;
let messages: ReturnType<typeof spyOn>;

beforeAll(async () => {
	await loadKit();
	await import("./components/council-view.tsx");
	page = await openPage();
	setRouting(undefined);
});
afterAll(async () => {
	setConnection(undefined);
	await page.unmount();
	await releaseDom();
});
beforeEach(() => {
	window.localStorage.clear();
	setLook("modern");
	resetCouncilModes();
	resetCouncilChoice();
	// A box another file folded would hide the scene's line and cards behind its bar.
	setDialogueFolded(false);
	setConnection(
		partial<AppConnection>({
			send: () => true,
			focus: () => undefined,
			say: () => true,
		}),
	);
	messages = spyOn(api, "messages").mockImplementation(async (room) => ({
		messages: room === CREW ? [REPLY] : [],
		more: false,
		cards: [],
	}));
	store.dispatch({ type: "rooms_loaded", rooms: ROOMS });
	store.dispatch({
		type: "prompt",
		room: CREW,
		prompt: approval("own", "Run the deploy?"),
	});
	store.dispatch({
		type: "prompt",
		room: THREAD,
		prompt: approval("carried", "Commit the changes?"),
	});
});
afterEach(async () => {
	messages.mockRestore();
	await page.render(null);
	for (const prompt of ["own", "carried"])
		store.dispatch({ type: "prompt_closed", prompt, outcome: "cancelled" });
	store.dispatch({ type: "rooms_loaded", rooms: [] });
	window.location.hash = "";
	window.localStorage.clear();
	resetCouncilModes();
	setLook(undefined);
});

const settle = (ms = 120) =>
	page.act(() => new Promise((done) => setTimeout(done, ms)));

const entries = {
	"the group's room": async () => {
		window.location.hash = `#/room/${CREW}`;
		await page.render(
			<ConfigContext.Provider value={config}>
				<RoomPage roomKey={CREW} />
			</ConfigContext.Provider>,
		);
	},
	"the round table": async () => {
		window.location.hash = "#/table/views";
		await page.render(
			<ConfigContext.Provider value={config}>
				<TablePage focus="views" />
			</ConfigContext.Provider>,
		);
	},
};

for (const [entry, open] of Object.entries(entries))
	for (const mode of ["scene", "chat"] as const)
		test(`${entry} in ${mode} mode shows the room's messages, its cards, the cards of its threads and the composer`, async () => {
			setCouncilMode(CREW, mode);
			await open();
			await settle();
			const body = document.querySelector(
				mode === "scene" ? ".room-scene" : ".table-chat",
			);
			expect(body).not.toBeNull();
			const text = body?.textContent ?? "";
			expect(text).toContain("Started Coding #12.");
			expect(text).toContain("Run the deploy?");
			expect(text).toContain("Commit the changes?");
			const from = body?.querySelector<HTMLAnchorElement>("a.card-from");
			expect(from?.textContent).toBe("From Coding #12");
			expect(from?.getAttribute("href")).toBe(hrefFor("room", THREAD));
			expect(body?.querySelector("textarea")).not.toBeNull();
		});
