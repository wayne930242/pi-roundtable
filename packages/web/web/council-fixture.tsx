import { afterAll, afterEach, beforeAll, beforeEach, spyOn } from "bun:test";
import { partial } from "pi-roundtable/testing";
import type {
	ConfigView,
	GroupProfileView,
	RoomView,
} from "../src/api-types.ts";
import { ActionMenuHost } from "./components/action-menu.tsx";
import { RoomConfirmHost } from "./components/room-confirms.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { closeMenu } from "./lib/action-menu.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { resetCouncilChoice } from "./lib/council.ts";
import { resetCouncilModes } from "./lib/council-mode.ts";
import { loadKit } from "./lib/kit.ts";
import { setLook } from "./lib/look.ts";
import { clearRoomConfirm } from "./lib/room-confirm.ts";
import { setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import { resetTableView } from "./lib/table-view.ts";
import { TablePage } from "./pages/table.tsx";

export const config: ConfigView = {
	title: "Console",
	panes: ["table"],
	timeZone: "UTC",
	look: "modern",
};

export const NAMES = [
	"guide",
	"scout",
	"mason",
	"cook",
	"nurse",
	"pilot",
	"smith",
	"baker",
	"clerk",
];

export const agent = (
	name: string,
	over: Partial<RoomView> = {},
): RoomView => ({
	key: `app:agent.${name}`,
	kind: "agent",
	name,
	displayName: name,
	home: name === "guide",
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
	...over,
});

export const group = (
	name: string,
	members: string[],
	over: Partial<RoomView> = {},
): RoomView => ({
	key: `app:group.${name}`,
	kind: "group",
	name,
	displayName: name[0]?.toUpperCase() + name.slice(1),
	home: false,
	readOnly: false,
	members,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
	...over,
});

export const everyone = NAMES.map((name) => agent(name));
export const profileOf = (
	name: string,
	members: string[],
	host = members[0] ?? "",
): GroupProfileView => ({
	name,
	displayName: name,
	members,
	host,
	room: `app:group.${name}`,
});

export let page: TestPage;
export let messages: ReturnType<typeof spyOn>;
export let rooms: ReturnType<typeof spyOn>;
export const realMatchMedia = globalThis.matchMedia;
export const sent: unknown[] = [];
export const said: Array<{ room: string; text: string }> = [];
/** The screen is a phone's: narrow, and touched. */
export let phone = false;

export const load = (list: RoomView[]) =>
	store.dispatch({ type: "rooms_loaded", rooms: list });
export const settle = (ms = 80) =>
	page.act(() => new Promise((done) => setTimeout(done, ms)));
export const q = <T extends Element>(selector: string): T | null =>
	document.querySelector<T>(selector);
export const all = <T extends Element>(selector: string): T[] => [
	...document.querySelectorAll<T>(selector),
];
export const button = (text: string): HTMLButtonElement | undefined =>
	all<HTMLButtonElement>("button").find((one) =>
		one.textContent?.trim().startsWith(text),
	);
export const typeInto = (element: HTMLInputElement | null, text: string) =>
	page.act(() => {
		if (!element) throw new Error("nothing to type into");
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(element, text);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
export const ticks = () =>
	all<HTMLInputElement>('.council-sheet input[type="checkbox"]');
export const tickOf = (name: string) =>
	ticks().find(
		(box) =>
			box.closest("label")?.querySelector("strong")?.textContent === name,
	);

export const show = async () => {
	await page.render(
		<ConfigContext.Provider value={config}>
			<TablePage />
			<ActionMenuHost />
			<RoomConfirmHost />
		</ConfigContext.Provider>,
	);
	await settle();
};

/** Registers the setup and cleanup hooks of the suites. */
export function councilPage(): void {
	beforeAll(async () => {
		await loadKit();
		// Lazy chunks the page asks for are loaded first, so no test depends on the clock or on another file.
		await import("./components/council-sheet.tsx");
		await import("./lib/menu-items.ts");
		page = await openPage();
		setRouting(undefined);
		window.matchMedia = ((query: string) => ({
			matches:
				phone &&
				(query.includes("max-width: 719px") ||
					query.includes("pointer: coarse")),
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
		sent.length = 0;
		said.length = 0;
		phone = false;
		resetCouncilChoice();
		window.localStorage.clear();
		// The look another file left would draw the Camelot strip over the chat.
		setLook("modern");
		resetTableView();
		resetCouncilModes();
		window.location.hash = "#/table";
		setConnection(
			partial<AppConnection>({
				send: (frame) => {
					sent.push(frame);
					return true;
				},
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
		rooms = spyOn(api, "rooms").mockImplementation(async () => ({
			pins: [],
			folders: [],
			rooms: Object.values(store.getState().rooms).flatMap((room) =>
				room.view ? [room.view] : [],
			),
		}));
	});
	afterEach(async () => {
		messages.mockRestore();
		rooms.mockRestore();
		closeMenu();
		clearRoomConfirm();
		await page.render(null);
		store.dispatch({ type: "rooms_loaded", rooms: [] });
		window.location.hash = "";
		window.localStorage.clear();
		resetCouncilModes();
		setLook(undefined);
	});
}

/** Makes the screen a phone's, or not. */
export function setPhone(value: boolean): void {
	phone = value;
}
