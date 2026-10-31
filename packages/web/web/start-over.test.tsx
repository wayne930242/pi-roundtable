import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { partial } from "pi-roundtable/testing";
import {
	type ConfigView,
	type RoomMessage,
	type RoomView,
	START_OVER_TEXT,
} from "../src/api-types.ts";
import { ArchivedSheetHost } from "./components/archived-sheet.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { archivedApi, closeArchived } from "./lib/message-sheets.ts";
import { setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import { RoomPage } from "./pages/room.tsx";

const ROOM = "app:agent.restarted";
const config: ConfigView = {
	title: "Console",
	panes: ["rooms"],
	timeZone: "UTC",
	look: "modern",
};
const view: RoomView = {
	key: ROOM,
	kind: "agent",
	name: "restarted",
	displayName: "Restarted",
	home: false,
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
};
const said = (id: number, text: string): RoomMessage => ({
	id,
	room: ROOM,
	kind: "owner",
	principalId: "ada",
	author: "Ada",
	text,
	files: [],
	at: `2026-10-30T10:0${id}:00.000Z`,
});
const line: RoomMessage = {
	id: 3,
	room: ROOM,
	kind: "system",
	author: "Assistant",
	text: START_OVER_TEXT,
	files: [],
	at: "2026-10-30T10:03:00.000Z",
};

let page: TestPage;
beforeAll(async () => {
	page = await openPage();
	setRouting(undefined);
	setConnection(
		partial<AppConnection>({ send: () => true, focus: () => undefined }),
	);
});
afterAll(async () => {
	await page.act(() => closeArchived());
	setConnection(undefined);
	await page.unmount();
	await releaseDom();
});

const settle = (ms = 60) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
const texts = () =>
	[...page.container.querySelectorAll("li.message")].map(
		(row) => row.querySelector(".bubble")?.textContent ?? row.textContent,
	);

test("a start over empties the open room at once, and the archived conversation shows what it held", async () => {
	const history = spyOn(api, "messages").mockResolvedValue({
		messages: [said(1, "first words"), said(2, "second words")],
		more: true,
		cards: [],
	});
	const archived = spyOn(archivedApi, "page").mockResolvedValue({
		messages: [said(1, "first words"), said(2, "second words")],
		more: false,
		cards: [],
	});
	try {
		store.dispatch({ type: "rooms_loaded", rooms: [view] });
		store.dispatch({
			type: "ready",
			protocol: 1,
			principal: "ada",
			name: "Ada",
			uploads: { perMessage: 4, maxBytes: 1000 },
		} as never);
		await page.render(
			<ConfigContext.Provider value={config}>
				<RoomPage roomKey={ROOM} />
				<ArchivedSheetHost />
			</ConfigContext.Provider>,
		);
		await page.act(() => settle(120));
		expect(texts().join(" ")).toContain("second words");
		// The line arrives over the socket, as it does on every device that shows the room.
		await page.act(() =>
			store.dispatch({ type: "message", room: ROOM, message: line }),
		);
		const room = page.container.querySelector(".room-content");
		expect(room?.querySelectorAll("li.message")).toHaveLength(0);
		expect(room?.querySelector(".older")).toBeNull();
		expect(room?.querySelector(".start-over")?.textContent).toContain(
			"Conversation started over",
		);
		expect(room?.querySelector(".start-over-empty")?.textContent).toBe(
			"No messages yet. Say hello.",
		);
		await page.click(room?.querySelector(".start-over button") ?? null);
		await page.act(() => settle(60));
		expect(archived).toHaveBeenCalledWith(ROOM, 3);
		const sheet = document.querySelector(".archived-log");
		expect(sheet?.textContent).toContain("first words");
		expect(sheet?.textContent).toContain("second words");
		// Something said after the line ends the empty state.
		await page.act(() =>
			store.dispatch({
				type: "message",
				room: ROOM,
				message: said(4, "new words"),
			}),
		);
		expect(room?.querySelector(".start-over-empty")).toBeNull();
	} finally {
		history.mockRestore();
		archived.mockRestore();
	}
});
