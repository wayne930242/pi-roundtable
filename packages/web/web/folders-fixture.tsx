import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { partial } from "pi-roundtable/testing";
import type { ConfigView, LayoutView, RoomView } from "../src/api-types.ts";
import { ActionMenuHost } from "./components/action-menu.tsx";
import { RoomConfirmHost } from "./components/room-confirms.tsx";
import { Toaster } from "./components/toaster.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { closeMenu } from "./lib/action-menu.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { clearFolderDialog } from "./lib/folder-dialogs.ts";
import { reloadCollapsed } from "./lib/folds.ts";
import { loadKit } from "./lib/kit.ts";
import { setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import { RoomsPage } from "./pages/rooms.tsx";

export const HOME = "app:agent.guide";
export const SCOUT = "app:agent.scout";
export const BUILD = "app:agent.build";
export const TEAM = "app:group.team";
export const F1 = "folder.00000000-0000-4000-8000-000000000001";
export const F2 = "folder.00000000-0000-4000-8000-000000000002";

export const config: ConfigView = {
	title: "Console",
	panes: ["rooms"],
	timeZone: "UTC",
	look: "modern",
};

export const view = (key: string, over: Partial<RoomView> = {}): RoomView => ({
	key,
	kind: key.includes(":group.") ? "group" : "agent",
	name: key.slice(key.indexOf(".") + 1),
	displayName: key.slice(key.indexOf(".") + 1),
	home: false,
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
	...over,
});

export const ROOMS = [
	view(HOME, { home: true }),
	view(SCOUT),
	view(BUILD),
	view(TEAM, { members: ["scout"] }),
];

export const load = (layout: Partial<LayoutView> = {}) =>
	store.dispatch({
		type: "rooms_loaded",
		rooms: ROOMS,
		pins: layout.pins ?? [],
		folders: layout.folders ?? [],
	});

export const stored = new Map<string, string>();
export let page: TestPage;

export const settle = (ms = 40) =>
	new Promise((resolve) => setTimeout(resolve, ms));
/** Waits for something that needs a hold and a lazy chunk, which a busy machine takes longer over. */
export async function until(done: () => boolean, ms = 4000): Promise<void> {
	const stop = Date.now() + ms;
	while (!done() && Date.now() < stop) await settle(25);
}

export const q = <T extends Element = HTMLElement>(
	selector: string,
): T | null => document.querySelector<T>(selector);
export const all = <T extends Element = HTMLElement>(selector: string): T[] => [
	...document.querySelectorAll<T>(selector),
];
export const rowOf = (name: string) =>
	all(".room-row").find((one) => one.textContent?.includes(name)) ?? null;
export const headings = () =>
	all(".section-title, .folder-head strong").map((one) => one.textContent);
export const rightClick = (target: Element | null) => {
	if (!target) throw new Error("nothing to click");
	return page.act(async () => {
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
};
export const menuItems = (): HTMLElement[] => all('[role^="menuitem"]');
export const labels = () => menuItems().map((one) => one.textContent);
export const choose = async (label: string) => {
	const item = menuItems().find((one) => one.textContent === label);
	if (!item) throw new Error(`no menu item ${label}: ${labels().join(", ")}`);
	await page.click(item);
	await settle(80);
};
export const typeInto = (element: HTMLInputElement | null, text: string) => {
	if (!element) throw new Error("nothing to type into");
	return page.act(() => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(element, text);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
};
export const dialog = (title: string) =>
	all<HTMLDialogElement>("dialog").find(
		(one) => one.open && one.getAttribute("aria-label") === title,
	);

export const List = (props: { active?: string }) => (
	<ConfigContext.Provider value={config}>
		<RoomsPage onSearch={() => undefined} active={props.active} />
		<ActionMenuHost />
		<RoomConfirmHost />
		<Toaster />
	</ConfigContext.Provider>
);

/** Renders the list and waits for the lazy folder chunk to draw the folders the store holds. */
export async function show(node: React.ReactNode): Promise<void> {
	await page.render(node);
	const want = store.getState().folders.length;
	for (let i = 0; i < 160 && all("[data-folder-block]").length < want; i += 1)
		await page.act(async () => {
			await settle(25);
		});
}

export const WORK = { id: F1, name: "Work", rooms: [SCOUT] };

/** Registers the setup and cleanup hooks of the suites. */
export function foldersPage(): void {
	beforeAll(async () => {
		await loadKit();
		page = await openPage();
		setRouting(undefined);
		setConnection(partial<AppConnection>({ send: () => true }));
		Object.defineProperty(globalThis, "localStorage", {
			value: {
				getItem: (key: string) => stored.get(key) ?? null,
				setItem: (key: string, value: string) => void stored.set(key, value),
				removeItem: (key: string) => void stored.delete(key),
			},
			configurable: true,
		});
	});
	afterAll(async () => {
		setConnection(undefined);
		await page.unmount();
		await releaseDom();
	});

	beforeEach(() => {
		window.innerWidth = 1280;
		stored.clear();
		reloadCollapsed();
		load();
	});
	afterEach(async () => {
		await page.act(() => {
			closeMenu();
			clearFolderDialog();
		});
		await page.render(null);
		store.dispatch({ type: "rooms_loaded", rooms: [], pins: [], folders: [] });
	});
}
