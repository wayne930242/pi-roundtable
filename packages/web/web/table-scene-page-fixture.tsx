import { afterAll, afterEach, beforeAll, beforeEach, spyOn } from "bun:test";
import { partial } from "pi-roundtable/testing";
import type {
	ClientFrame,
	ConfigView,
	RoomMessage,
	RoomView,
} from "../src/api-types.ts";
import { ConfigContext } from "./components/../lib/config.ts";
import { DialogueBox } from "./components/dialogue-box.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { clearDrafts } from "./lib/drafts.ts";
import { loadKit } from "./lib/kit.ts";
import { setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import { DIALOGUE_FOLDED_KEY, resetTableView } from "./lib/table-view.ts";

export const SCOUT = "app:agent.lena";
export const MASON = "app:agent.otto";

export const config: ConfigView = {
	title: "Console",
	panes: ["table"],
	timeZone: "UTC",
	look: "modern",
};

export const agent = (name: string, displayName = name): RoomView => ({
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

export const reply = (
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

export const sent: ClientFrame[] = [];
export let page: TestPage;
export let reduced = false;
export const realMatchMedia = globalThis.matchMedia;

export const arrive = () => settle(30);

export let fetched: ReturnType<typeof spyOn>;

export const settle = (ms = 80) =>
	page.act(() => new Promise((done) => setTimeout(done, ms)));
export const query = <T extends Element>(selector: string): T | null =>
	page.container.querySelector<T>(selector);

/** The box on an agent's room, as the scene's dialogue box is built: open, over a table. */
export const render = (room: string) =>
	page.render(
		<ConfigContext.Provider value={config}>
			<DialogueBox roomKey={room} open />
		</ConfigContext.Provider>,
	);

export const CREW = "app:group.crew";

export const crew = (): RoomView => ({
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

/** Registers the setup and cleanup hooks of the suites. */
export function sceneTablePage(): void {
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
}

/** Makes the screen ask for reduced motion, or not. */
export function setReduced(value: boolean): void {
	reduced = value;
}
