import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { partial } from "pi-roundtable/testing";
import type { ConfigView, RoomMessage, RoomView } from "../src/api-types.ts";
import { ActionMenuHost } from "./components/action-menu.tsx";
import { Composer } from "./components/composer.tsx";
import { MessageRow } from "./components/message-row.tsx";
import { RoomConfirmHost } from "./components/room-confirms.tsx";
import { Toaster } from "./components/toaster.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { closeMenu } from "./lib/action-menu.ts";
import { closeAgentSheet } from "./lib/agent-sheet.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { clearDrafts } from "./lib/drafts.ts";
import { loadKit } from "./lib/kit.ts";
import { setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import { RoomsPage } from "./pages/rooms.tsx";

export const SCOUT = "app:agent.scout";
export const TEAM = "app:group.team";
export const WORK = "app:thread.0b5e7c1a-0000-4000-8000-000000000001";

export const config: ConfigView = {
	title: "Console",
	panes: ["rooms"],
	timeZone: "UTC",
	look: "modern",
};

export const view = (key: string, over: Partial<RoomView> = {}): RoomView => ({
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

export const said = (over: Partial<RoomMessage> = {}): RoomMessage => ({
	id: 7,
	room: SCOUT,
	kind: "agent",
	agent: "scout",
	author: "Scout",
	text: "hello **bold**\nsecond line",
	files: [],
	at: "2026-10-28T10:00:00.000Z",
	...over,
});

export let page: TestPage;

export const settle = (ms = 40) =>
	new Promise((resolve) => setTimeout(resolve, ms));

export const rightClick = async (target: Element | null, opens = true) => {
	if (!target) throw new Error("nothing to click");
	// The menu's builders load on demand, so the menu is there a moment after the click: the first
	// one waits for the chunk, however busy the machine is. The wait is outside `act`, which holds
	// React's updates back until it returns, so the loop would never see the menu inside it.
	await page.act(async () => {
		target.dispatchEvent(
			new MouseEvent("contextmenu", {
				bubbles: true,
				cancelable: true,
				clientX: 120,
				clientY: 80,
			}),
		);
		await settle(30);
	});
	const stop = Date.now() + 3000;
	while (
		opens &&
		!document.querySelector('[role^="menuitem"]') &&
		Date.now() < stop
	)
		await page.act(async () => {
			await settle(20);
		});
};
/** Waits for the page to show the element: a part that loads on demand shows a moment after its render, however busy the machine is. */
export const shown = async (selector: string): Promise<Element | null> => {
	const stop = Date.now() + 3000;
	while (!document.querySelector(selector) && Date.now() < stop)
		await page.act(async () => {
			await settle(20);
		});
	return document.querySelector(selector);
};
export const menuItems = (): HTMLElement[] => [
	...document.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
];
export const labels = () => menuItems().map((one) => one.textContent);
export const checked = (label: string) =>
	menuItems()
		.find((one) => one.textContent === label)
		?.getAttribute("aria-checked");
export const choose = async (label: string) => {
	const item = menuItems().find((one) => one.textContent === label);
	if (!item) throw new Error(`no menu item ${label}: ${labels().join(", ")}`);
	await page.click(item);
	await settle(80);
};
export const q = <T extends Element = HTMLElement>(
	selector: string,
): T | null => document.querySelector<T>(selector);
export const rowOf = (name: string) =>
	[...document.querySelectorAll<HTMLElement>(".room-row")].find((one) =>
		one.textContent?.includes(name),
	) ?? null;

export function copied(): string[] {
	const written: string[] = [];
	Object.defineProperty(navigator, "clipboard", {
		value: {
			writeText: (text: string) => {
				written.push(text);
				return Promise.resolve();
			},
		},
		configurable: true,
	});
	return written;
}

export const List = () => (
	<ConfigContext.Provider value={config}>
		<RoomsPage onSearch={() => undefined} />
		<ActionMenuHost />
		<RoomConfirmHost />
		<Toaster />
	</ConfigContext.Provider>
);

// ── Agent and group rows ─────────────────────────────────────────────────────────────────────

export const Message = (props: {
	message?: RoomMessage;
	quotable?: boolean;
	composer?: boolean;
}) => (
	<ConfigContext.Provider value={config}>
		<ul>
			<MessageRow
				message={props.message ?? said()}
				character={undefined}
				header
				enter={false}
				timeZone="UTC"
				quotable={props.quotable ?? true}
			/>
		</ul>
		{props.composer ? (
			<Composer
				draftKey={SCOUT}
				name="scout"
				limits={undefined}
				stoppable={false}
				onSend={() => undefined}
				onStop={() => undefined}
			/>
		) : null}
		<ActionMenuHost />
	</ConfigContext.Provider>
);

/** Registers the setup and cleanup hooks of the suites. */
export function menusPage(): void {
	beforeAll(async () => {
		await loadKit();
		page = await openPage();
		setRouting(undefined);
		setConnection(partial<AppConnection>({ send: () => true }));
	});
	afterAll(async () => {
		setConnection(undefined);
		await page.unmount();
		await releaseDom();
	});

	beforeEach(() => {
		window.innerWidth = 1280;
		window.location.hash = "#/rooms";
		store.dispatch({
			type: "rooms_loaded",
			rooms: [
				view(SCOUT, { last: said() }),
				view(TEAM, { kind: "group", members: ["scout"] }),
				view(WORK, {
					kind: "thread",
					name: "thread.0b5e7c1a-0000-4000-8000-000000000001",
					displayName: "Check the logs",
					parent: SCOUT,
					readOnly: true,
				}),
			],
		});
	});
	afterEach(async () => {
		await page.act(() => closeMenu());
		await page.render(null);
		store.dispatch({ type: "rooms_loaded", rooms: [] });
		clearDrafts();
		closeAgentSheet();
		Reflect.deleteProperty(navigator, "share");
		Reflect.deleteProperty(navigator, "canShare");
	});
}
