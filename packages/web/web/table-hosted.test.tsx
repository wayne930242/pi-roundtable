import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	test,
} from "bun:test";
import { partial } from "pi-roundtable/testing";
import type { ClientFrame, ConfigView } from "../src/api-types.ts";
import type { HostListView } from "../src/host/views.ts";
import { stubAnimations } from "./animation-stub.ts";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { resetHostSeats } from "./lib/host-seats.ts";
import { loadKit } from "./lib/kit.ts";
import { setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import { TablePage } from "./pages/table.tsx";

// The round table of a person who is not an owner: it seats the host rooms their kinds list, follows
// only those rooms, and opens a room's own page where the table would have opened a dialogue.

const AIDA = "app:inbox.thread-aida0001";
const BODO = "app:inbox.thread-bodo0002";
const CODA = "app:desk.thread-coda0003";
const ELSE = "app:inbox.thread-else0004";

const config = (tier: "owner" | "member" | "admin"): ConfigView => ({
	title: "Support",
	panes: ["rooms", "table"],
	timeZone: "UTC",
	look: "modern",
	app: { surface: "app", protocol: "p" },
	tier,
	kinds: [
		{ kind: "inbox", label: "Inbox" },
		{ kind: "desk", label: "Desk" },
	],
});

const summary = (key: string, title: string, over: object = {}) => ({
	id: key.slice(key.lastIndexOf(".") + 1),
	key,
	title,
	...over,
});

const lists: Record<string, HostListView | number> = {};
const requests: { url: string; method: string }[] = [];
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
const realFetch = globalThis.fetch;
const realMatchMedia = globalThis.matchMedia;

const sent: ClientFrame[] = [];
let page: TestPage;

beforeAll(async () => {
	await loadKit();
	page = await openPage();
	setRouting(undefined);
	window.matchMedia = ((query: string) => ({
		matches: false,
		media: query,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		addListener: () => undefined,
		removeListener: () => undefined,
		dispatchEvent: () => false,
		onchange: null,
	})) as typeof window.matchMedia;
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const url = String(input);
		requests.push({ url, method: init?.method ?? "GET" });
		const kind = /host\/([a-z]+)/.exec(url)?.[1];
		const list = kind ? lists[kind] : undefined;
		if (typeof list === "object") return json(list);
		return json({ error: "There is no such list." }, 404);
	}) as typeof fetch;
	setConnection(
		partial<AppConnection>({
			send: (frame: ClientFrame) => {
				sent.push(frame);
				return true;
			},
		}),
	);
});
afterAll(async () => {
	setConnection(undefined);
	globalThis.fetch = realFetch;
	window.matchMedia = realMatchMedia;
	await page.unmount();
	await releaseDom();
});
beforeEach(() => {
	for (const key of Object.keys(lists)) delete lists[key];
	requests.length = 0;
	sent.length = 0;
	resetHostSeats();
	store.dispatch({
		type: "ready",
		protocol: 1,
		principal: "p-mel",
		name: "Mel",
		uploads: { perMessage: 4, maxBytes: 1000 },
	});
});
afterEach(async () => {
	await page.render(null);
	window.location.hash = "";
});

const settle = (ms = 80) =>
	page.act(() => new Promise((done) => setTimeout(done, ms)));
const shown = (tier: "owner" | "member" | "admin") =>
	page.render(
		<ConfigContext.Provider value={config(tier)}>
			<TablePage />
		</ConfigContext.Provider>,
	);
const seats = (): Record<string, string | null> =>
	Object.fromEntries(
		[...page.container.querySelectorAll("g.seat")].map((seat) => [
			(seat.getAttribute("aria-label") ?? "").replace(/ \(.*$/, ""),
			seat.getAttribute("data-state"),
		]),
	);
const subscribed = (type: "subscribe" | "unsubscribe") =>
	sent
		.filter((frame) => frame.type === type)
		.map((frame) => (frame as { room: string }).room)
		.sort();
const buttons = () =>
	[...page.container.querySelectorAll("button")].map((button) =>
		button.textContent?.trim(),
	);

test("a member's ring seats the rooms their kinds list, newest first, and nothing else", async () => {
	lists.inbox = {
		kind: "inbox",
		label: "Inbox",
		rooms: [
			summary(AIDA, "Aida", { lastAt: "2026-10-29T09:00:00.000Z" }),
			summary(BODO, "Bodo", { lastAt: "2026-10-29T11:00:00.000Z" }),
		],
	};
	// A kind that does not answer (the viewer may not list it) seats nobody and does not stop the others.
	lists.desk = 404;
	await shown("member");
	await settle();
	expect(Object.keys(seats())).toEqual(["Bodo", "Aida"]);
	// The agent rooms and the mute behind the owners' sheet are never asked of.
	expect(requests.map((one) => one.url).join("\n")).not.toMatch(
		/\/rooms|mute|workspace|overview|skills|presence/,
	);
	expect(requests.every((one) => one.method === "GET")).toBe(true);
	expect(buttons()).not.toContain("Who's at the table");
});

test("only the seated rooms are followed, and they are let go when the table closes", async () => {
	lists.inbox = {
		kind: "inbox",
		label: "Inbox",
		rooms: [summary(AIDA, "Aida"), summary(BODO, "Bodo")],
	};
	lists.desk = {
		kind: "desk",
		label: "Desk",
		rooms: [summary(CODA, "Coda")],
	};
	await shown("admin");
	await settle();
	expect(Object.keys(seats()).sort()).toEqual(["Aida", "Bodo", "Coda"]);
	expect(subscribed("subscribe")).toEqual([AIDA, BODO, CODA].sort());
	expect(subscribed("unsubscribe")).toEqual([]);
	await page.render(null);
	expect(subscribed("unsubscribe")).toEqual([AIDA, BODO, CODA].sort());
});

test("a seat opens its room's own page, where the room's own access decides what can be written", async () => {
	lists.inbox = {
		kind: "inbox",
		label: "Inbox",
		rooms: [summary(AIDA, "Aida")],
	};
	await shown("member");
	await settle();
	const seat = page.container.querySelector('g.seat[aria-label^="Aida"]');
	expect(seat).not.toBeNull();
	// The seat is opened as the dive into it ends.
	const motion = stubAnimations(true);
	try {
		seat?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		await settle();
	} finally {
		motion.restore();
	}
	expect(decodeURIComponent(window.location.hash)).toBe(`#/room/${AIDA}`);
});

test("a seat shows what its room's frames say, and a room that is not seated draws nothing", async () => {
	lists.inbox = {
		kind: "inbox",
		label: "Inbox",
		rooms: [
			summary(AIDA, "Aida", { lastAt: "2026-10-29T09:00:00.000Z" }),
			summary(BODO, "Bodo", { attention: true }),
		],
	};
	await shown("member");
	await settle();
	// A room's list entry that asks for something is a seat that waits.
	expect(seats()).toEqual({ Aida: "idle", Bodo: "waiting" });
	await page.act(async () => {
		store.dispatch({
			type: "activity",
			room: AIDA,
			typing: true,
			stoppable: false,
			phase: "working",
			at: Date.now(),
		});
		// A frame of a room the table does not seat is kept by the store but seats no one.
		store.dispatch({
			type: "activity",
			room: ELSE,
			typing: true,
			stoppable: false,
			at: Date.now(),
		});
	});
	await settle();
	expect(seats()).toEqual({ Aida: "working", Bodo: "waiting" });
});

test("with no room to seat the table says so, and offers no sheet of who sits", async () => {
	lists.inbox = { kind: "inbox", label: "Inbox", rooms: [] };
	lists.desk = 404;
	await shown("member");
	await settle();
	expect(page.container.textContent).toContain(
		"There are no rooms to seat yet.",
	);
	expect(page.container.querySelector("g.seat")).toBeNull();
	expect(buttons()).not.toContain("Who's at the table");
	expect(sent).toEqual([]);
});

test("an address that names a seat is not a close-up for a member: it goes back to the whole ring", async () => {
	lists.inbox = {
		kind: "inbox",
		label: "Inbox",
		rooms: [summary(AIDA, "Aida")],
	};
	window.location.hash = "#/table/inbox.thread-aida0001";
	await page.render(
		<ConfigContext.Provider value={config("member")}>
			<TablePage focus="inbox.thread-aida0001" />
		</ConfigContext.Provider>,
	);
	await settle();
	expect(decodeURIComponent(window.location.hash)).toBe("#/table");
	expect(page.container.querySelector(".dialogue-box")).toBeNull();
});

test("an owner whose host has kinds of room sits the agents first and then the listed host rooms, newest first", async () => {
	store.dispatch({
		type: "rooms_loaded",
		rooms: [
			{
				key: "app:agent.guide",
				kind: "agent",
				name: "guide",
				displayName: "Guide",
				home: true,
				readOnly: false,
				mode: { yolo: false, longRunning: false },
				typing: false,
				stoppable: false,
			},
		],
	});
	lists.inbox = {
		kind: "inbox",
		label: "Inbox",
		rooms: [
			summary(AIDA, "Aida", { lastAt: "2026-10-29T09:00:00.000Z" }),
			summary(BODO, "Bodo", { lastAt: "2026-10-29T11:00:00.000Z" }),
		],
	};
	// A kind the owner may not list seats nobody.
	lists.desk = 404;
	await shown("owner");
	await settle();
	expect(Object.keys(seats())).toEqual(["Guide", "Bodo", "Aida"]);
	expect(subscribed("subscribe")).toEqual([AIDA, BODO].sort());
	// A host room opens its own page, not an agent's dialogue box.
	page.container
		.querySelector('g.seat[aria-label^="Bodo"]')
		?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	expect(decodeURIComponent(window.location.hash)).toBe(`#/room/${BODO}`);
	expect(page.container.querySelector(".dialogue-box")).toBeNull();
});

test("an owner's table of a host without kinds of room is the agents' as before (the agent left by the last test sits): no host list is asked and no room is followed", async () => {
	lists.inbox = {
		kind: "inbox",
		label: "Inbox",
		rooms: [summary(AIDA, "Aida")],
	};
	await page.render(
		<ConfigContext.Provider value={{ ...config("owner"), kinds: [] }}>
			<TablePage />
		</ConfigContext.Provider>,
	);
	await settle();
	expect(requests.some((one) => one.url.includes("host/"))).toBe(false);
	expect(sent).toEqual([]);
	expect(Object.keys(seats())).toEqual(["Guide"]);
});
