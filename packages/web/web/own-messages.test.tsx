import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { partial } from "pi-roundtable/testing";
import type { ConfigView, RoomMessage, RoomView } from "../src/api-types.ts";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import { RoomPage } from "./pages/room.tsx";

// Each test opens a room of its own: the store keeps the messages a room already holds.
let opened = 0;
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

const owner = (
	room: string,
	id: number,
	over: Partial<RoomMessage> = {},
): RoomMessage => ({
	id,
	room,
	kind: "owner",
	principalId: "ada",
	author: "Ada",
	text: `message ${id}`,
	files: [],
	at: `2026-10-30T10:0${id}:00.000Z`,
	...over,
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

/** Opens the room as the person whose principal is `me`. */
async function openAs(
	me: string,
	shared: boolean,
	messages: (room: string) => RoomMessage[],
) {
	const key = `app:agent.room${++opened}`;
	const room = view(key, shared ? { notes: true } : {});
	const history = spyOn(api, "messages").mockResolvedValue({
		messages: messages(key),
		more: false,
		cards: [],
	});
	store.dispatch({ type: "rooms_loaded", rooms: [room] });
	store.dispatch({
		type: "ready",
		protocol: 1,
		principal: me,
		name: me,
		uploads: { perMessage: 4, maxBytes: 1000 },
	} as never);
	await page.render(
		<ConfigContext.Provider value={config}>
			<RoomPage roomKey={room.key} />
		</ConfigContext.Provider>,
	);
	await page.act(() => settle(120));
	return history;
}

const row = (id: number) =>
	page.container.querySelector<HTMLElement>(`li.message[data-mid="${id}"]`);

test("in a room two owners read, another owner's message is theirs, with their name and picture", async () => {
	const history = await openAs("bob", true, (room) => [
		owner(room, 1, { text: "from Ada" }),
		owner(room, 2, { principalId: "bob", author: "Bob", text: "from Bob" }),
	]);
	try {
		const ada = row(1);
		expect(ada?.hasAttribute("data-mine")).toBe(false);
		expect(ada?.querySelector(".message-meta strong")?.textContent).toBe("Ada");
		expect(ada?.querySelector(".message-avatar img")?.getAttribute("src")).toBe(
			"api/people/ada/picture",
		);
		const bob = row(2);
		expect(bob?.hasAttribute("data-mine")).toBe(true);
		expect(bob?.querySelector(".message-avatar")).toBeNull();
	} finally {
		history.mockRestore();
	}
});

test("the same two messages read the other way round for Ada", async () => {
	const history = await openAs("ada", true, (room) => [
		owner(room, 1, { text: "from Ada" }),
		owner(room, 2, { principalId: "bob", author: "Bob", text: "from Bob" }),
	]);
	try {
		expect(row(1)?.hasAttribute("data-mine")).toBe(true);
		expect(row(2)?.hasAttribute("data-mine")).toBe(false);
	} finally {
		history.mockRestore();
	}
});

test("a stored message with no principal is nobody's own where several owners read, and the viewer's where one does", async () => {
	const unattributed = (room: string): RoomMessage => {
		const { principalId: _dropped, ...rest } = owner(room, 1);
		return rest;
	};
	const shared = await openAs("bob", true, (room) => [unattributed(room)]);
	try {
		const unnamed = row(1);
		expect(unnamed?.hasAttribute("data-mine")).toBe(false);
		expect(unnamed?.querySelector("img")).toBeNull();
	} finally {
		shared.mockRestore();
	}
	const alone = await openAs("ada", false, (room) => [unattributed(room)]);
	try {
		expect(row(1)?.hasAttribute("data-mine")).toBe(true);
	} finally {
		alone.mockRestore();
	}
});

test("a room one owner reads draws every owner message as the owner's, as it always did", async () => {
	const history = await openAs("ada", false, (room) => [
		owner(room, 1),
		owner(room, 2, { text: "again" }),
	]);
	try {
		for (const id of [1, 2]) {
			const one = row(id);
			expect(one?.getAttribute("data-mine")).toBe("true");
			expect(one?.querySelector(".message-avatar")).toBeNull();
		}
	} finally {
		history.mockRestore();
	}
});
