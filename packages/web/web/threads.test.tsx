import { afterEach, beforeAll, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConfigView, RoomMessage, RoomView } from "../src/api-types.ts";
import { MessageRow } from "./components/message-row.tsx";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { initialState, reduce } from "./lib/rooms.ts";
import { RoomsPage } from "./pages/rooms.tsx";

const GUIDE = "app:agent.guide";
const THREAD = "app:thread.0b5e7c1a-0000-4000-8000-000000000001";
const OLD = "app:thread.0b5e7c1a-0000-4000-8000-000000000002";
const SECOND = "app:thread.0b5e7c1a-0000-4000-8000-000000000003";

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

const line = (text: string): RoomMessage => ({
	id: 5,
	room: GUIDE,
	kind: "system",
	author: "Knight",
	text,
	files: [],
	at: "2026-10-28T10:00:00.000Z",
});

const row = (message: RoomMessage) =>
	renderToStaticMarkup(
		<ConfigContext.Provider
			value={{ ...config, app: { surface: "app", protocol: "p" } }}
		>
			<MessageRow
				message={message}
				character={undefined}
				header
				enter={false}
				timeZone="UTC"
				quotable
			/>
		</ConfigContext.Provider>,
	);

// The thread cards load lazily; rendering the list once starts the load, so later renders find it ready.
beforeAll(async () => {
	store.dispatch({
		type: "rooms_loaded",
		rooms: [view(GUIDE, { home: true }), thread(THREAD, "Warm up")],
	});
	renderToStaticMarkup(
		<ConfigContext.Provider value={config}>
			<RoomsPage onSearch={() => undefined} />
		</ConfigContext.Provider>,
	);
	await import("./pages/thread-list.tsx");
});

afterEach(() => {
	store.dispatch({ type: "rooms_loaded", rooms: [] });
});

test("the start line of a thread links its room, and no other address becomes a link in the app", () => {
	const html = row(
		line(
			`🧵 Started: Scout → [Scout](${THREAD}) and [bad](javascript:alert(1)) [other](app:agent.guide)`,
		),
	);
	expect(html).toContain(
		`<a class="thread-link" href="#/room/${encodeURIComponent(THREAD)}">Scout</a>`,
	);
	expect(html).not.toContain("javascript:");
	expect(html).not.toContain('href="app:agent.guide"');
	// A plain system line stays one line of text.
	expect(row(line("Conversation started over"))).not.toContain("<a ");
});

test("a thread link of another surface is no link", () => {
	const html = row(
		line(
			"🧵 Started: [Scout](other:thread.0b5e7c1a-0000-4000-8000-000000000001)",
		),
	);
	expect(html).not.toContain("<a ");
	expect(html).not.toContain("thread-link");
});

test("an edited message takes its new text in place, and one the page does not hold stays unheld", () => {
	const held = line("🧵 Started: Scout");
	let state = reduce(initialState(), {
		type: "message",
		room: GUIDE,
		message: held,
	});
	const edited = { ...held, text: `🧵 Started: Scout → [Scout](${THREAD})` };
	state = reduce(state, { type: "edited", room: GUIDE, message: edited });
	expect(state.rooms[GUIDE]?.messages).toEqual([edited]);
	const other = reduce(state, {
		type: "edited",
		room: GUIDE,
		message: { ...edited, id: 99 },
	});
	expect(other.rooms[GUIDE]?.messages).toEqual([edited]);
});

test("the list nests a room's threads under it, with the finished ones folded away", () => {
	store.dispatch({
		type: "rooms_loaded",
		rooms: [
			view(GUIDE, { home: true, displayName: "Guide" }),
			thread(THREAD, "Check the disk"),
			thread(SECOND, "Fix the build", { typing: true }),
			thread(OLD, "Earlier job", { closed: true }),
		],
	});
	const html = renderToStaticMarkup(
		<ConfigContext.Provider value={config}>
			<RoomsPage onSearch={() => undefined} />
		</ConfigContext.Provider>,
	);
	const home = html.indexOf('data-home="true"');
	const nested = html.indexOf('class="thread-group"');
	expect(home).toBeGreaterThan(-1);
	expect(nested).toBeGreaterThan(home);
	// The open threads are listed, the finished one sits inside a closed fold.
	const open = html.slice(nested, html.indexOf("<details"));
	expect(open).toContain("Check the disk");
	expect(open).toContain("Fix the build");
	expect(open).not.toContain("Earlier job");
	const fold = html.slice(html.indexOf("<details"));
	expect(fold).toContain("1 finished thread");
	expect(fold).toContain("Earlier job");
	expect(
		html.slice(html.indexOf("<details"), html.indexOf("</summary>")),
	).not.toContain(" open");
	// No section of loose threads while every thread has its room.
	expect(html).not.toContain("Dispatch threads</h2>");
});

test("a thread whose room the list lacks still shows, apart; an open finished thread is the one in view", () => {
	store.dispatch({
		type: "rooms_loaded",
		rooms: [
			thread(THREAD, "Lost parent", { parent: "app:agent.gone" }),
			view(GUIDE, { home: true, displayName: "Guide" }),
			thread(OLD, "Earlier job", { closed: true }),
		],
	});
	const html = renderToStaticMarkup(
		<ConfigContext.Provider value={config}>
			<RoomsPage onSearch={() => undefined} active={OLD} />
		</ConfigContext.Provider>,
	);
	expect(html).toContain("Dispatch threads</h2>");
	expect(html).toContain("Lost parent");
	// The finished thread being read keeps its fold open.
	expect(html).toMatch(/<details class="thread-closed" open/);
});
