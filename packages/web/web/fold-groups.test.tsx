import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	test,
} from "bun:test";
import { partial } from "pi-roundtable/testing";
import type {
	ConfigView,
	LayoutView,
	PromptFrame,
	RoomView,
} from "../src/api-types.ts";
import { RoomSwitcher, useSwitcher } from "./components/switcher.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { COLLAPSED_KEY, reloadCollapsed, sectionFold } from "./lib/folds.ts";
import { seedUnread } from "./lib/host-state.ts";
import { loadKit } from "./lib/kit.ts";
import { setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import { RoomsPage } from "./pages/rooms.tsx";

// Rooms of this file's own: the store is shared by the files of a run.
const HOME = "app:agent.fg-home";
const PIN = "app:agent.fg-pin";
const W1 = "app:agent.fg-w1";
const W2 = "app:agent.fg-w2";
const W3 = "app:agent.fg-w3";
const FREE = "app:agent.fg-free";
const TEAM = "app:group.fg-team";
const F1 = "folder.00000000-0000-4000-8000-0000000000f1";

const config: ConfigView = {
	title: "Console",
	panes: ["rooms"],
	timeZone: "UTC",
	look: "modern",
};

const short = (key: string) => key.slice(key.indexOf(".") + 1);
const view = (key: string): RoomView => ({
	key,
	kind: key.includes(":group.") ? "group" : "agent",
	name: short(key),
	displayName: short(key),
	home: key === HOME,
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
});

const ROOMS = [PIN, W1, W2, W3, FREE, TEAM].map(view);
const load = (layout: Partial<LayoutView> = {}) =>
	store.dispatch({
		type: "rooms_loaded",
		rooms: [view(HOME), ...ROOMS],
		pins: layout.pins ?? [],
		folders: layout.folders ?? [],
	});
const WORK = { id: F1, name: "Work", rooms: [W1, W2, W3] };

const stored = new Map<string, string>();
let page: TestPage;
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
	seedUnread({ [W1]: 0, [W2]: 0, [W3]: 0, [FREE]: 0, [PIN]: 0 });
});
afterEach(async () => {
	await page.render(null);
	store.dispatch({ type: "rooms_loaded", rooms: [], pins: [], folders: [] });
});

const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const all = (selector: string) => [
	...document.querySelectorAll<HTMLElement>(selector),
];
const names = (selector: string) =>
	all(selector).map((one) => one.textContent?.trim());
const toggleOf = (title: string) =>
	all(".fold-toggle").find((one) => one.textContent?.includes(title)) ?? null;
/** Whether a room's row is drawn in the list. */
const has = (name: string) =>
	all(".room-row").some((row) => row.textContent?.includes(name));
const folded = () => JSON.parse(stored.get(COLLAPSED_KEY) ?? "[]") as string[];

const List = (props: { active?: string }) => (
	<ConfigContext.Provider value={config}>
		<RoomsPage onSearch={() => undefined} active={props.active} />
	</ConfigContext.Provider>
);

/** Renders the list and waits for the lazy fold code to draw a heading's button. */
async function show(node: React.ReactNode, buttons = 1): Promise<void> {
	await page.render(node);
	for (let i = 0; i < 160 && all(".fold-toggle").length < buttons; i += 1)
		await page.act(async () => {
			await settle();
		});
}

test("the plain list folds Knights and Groups apart: a tap on the heading, aria-expanded, a count, and the fold kept for this device", async () => {
	load();
	await show(<List />, 2);
	const knights = toggleOf("Knights");
	expect(knights?.getAttribute("aria-expanded")).toBe("true");
	expect(
		document.getElementById(knights?.getAttribute("aria-controls") ?? ""),
	).not.toBeNull();
	expect(has("fg-w1")).toBe(true);
	await page.click(knights);
	expect(toggleOf("Knights")?.getAttribute("aria-expanded")).toBe("false");
	expect(toggleOf("Knights")?.hasAttribute("aria-label")).toBe(false);
	// Only the knights fold; Home and Groups stay. The heading says how many rooms it holds.
	expect(has("fg-w1")).toBe(false);
	expect(has("fg-team")).toBe(true);
	expect(toggleOf("Knights")?.textContent).toContain("rooms");
	expect(folded()).toEqual([sectionFold("agents")]);
	await page.click(toggleOf("Knights"));
	expect(has("fg-w1")).toBe(true);
	expect(folded()).toEqual([]);
});

test("a folded section keeps the open room, a room with a card waiting and a room with unread messages; the others fold away", async () => {
	load();
	stored.set(COLLAPSED_KEY, JSON.stringify([sectionFold("agents")]));
	reloadCollapsed();
	const card: PromptFrame = {
		id: "fg-p1",
		kind: "approval",
		title: "Run it?",
		message: "Run",
		purpose: "action",
	};
	store.dispatch({ type: "prompt", room: W3, prompt: card });
	seedUnread({ [FREE]: 2 });
	await show(<List active={W1} />, 2);
	expect(["fg-w1", "fg-w2", "fg-w3", "fg-free", "fg-pin"].map(has)).toEqual([
		true,
		false,
		true,
		true,
		false,
	]);
	// The rest of the list does not fold with it.
	expect(has("fg-team")).toBe(true);
	store.dispatch({
		type: "prompt_closed",
		prompt: "fg-p1",
		outcome: "approved",
	});
	seedUnread({ [FREE]: 0 });
});

test("the arranged list folds Pinned and Ungrouped, and the folder next to them; each is its own fold", async () => {
	load({ pins: [PIN, W1], folders: [{ ...WORK, rooms: [W2, W3] }] });
	await show(<List active={FREE} />, 2);
	for (let i = 0; i < 160 && !q(".folder-toggle"); i += 1)
		await page.act(async () => {
			await settle();
		});
	expect(
		all(".fold-toggle, .folder-toggle").map((one) =>
			one.getAttribute("aria-expanded"),
		),
	).toEqual(["true", "true", "true"]);
	await page.click(toggleOf("Pinned"));
	expect(folded()).toEqual([sectionFold("pinned")]);
	expect(has("fg-pin")).toBe(false);
	await page.click(toggleOf("Ungrouped"));
	// FREE is the open room: it stays under the folded Ungrouped heading.
	expect(has("fg-free")).toBe(true);
	expect(has("fg-team")).toBe(false);
	expect(folded().sort()).toEqual(
		[sectionFold("pinned"), sectionFold("rest")].sort(),
	);
});

test("a fold of a folder that is gone is forgotten once the list is known, and a fold of a section never is", async () => {
	load({ pins: [PIN], folders: [WORK] });
	stored.set(
		COLLAPSED_KEY,
		JSON.stringify(["folder.gone", sectionFold("pinned"), F1]),
	);
	reloadCollapsed();
	await show(<List />, 1);
	for (let i = 0; i < 80 && folded().length > 2; i += 1)
		await page.act(async () => {
			await settle();
		});
	expect(folded().sort()).toEqual([sectionFold("pinned"), F1].sort());
});

/** A room's page in little: the drawer over it. */
function Drawer(props: { current: string }) {
	const switcher = useSwitcher(true);
	return (
		<div {...switcher.surface}>
			<button type="button" id="open" onClick={switcher.show}>
				open
			</button>
			<RoomSwitcher {...switcher.drawer} current={props.current} />
		</div>
	);
}

const drawerRows = () => names(".switcher-row strong");
const heading = (title: string) =>
	all(".switcher-heading .fold-toggle").find((one) =>
		one.textContent?.includes(title),
	) ?? null;
async function openDrawer(current: string): Promise<void> {
	window.innerWidth = 390;
	await page.render(<Drawer current={current} />);
	await page.click(q("#open"));
	for (let i = 0; i < 160 && !heading("Work"); i += 1)
		await page.act(async () => {
			await settle();
		});
}

test("the drawer's headings fold their groups, keep the open room and the rooms with unread, and a search looks through the fold", async () => {
	load({ pins: [PIN], folders: [WORK] });
	seedUnread({ [W3]: 4 });
	await openDrawer(W1);
	expect(drawerRows()).toEqual([
		"fg-home",
		"fg-pin",
		"fg-w1",
		"fg-w2",
		"fg-w3",
		"fg-free",
		"fg-team",
	]);
	const work = heading("Work");
	expect(work?.getAttribute("aria-expanded")).toBe("true");
	await page.click(work);
	expect(heading("Work")?.getAttribute("aria-expanded")).toBe("false");
	expect(heading("Work")?.textContent).toContain("3 rooms");
	// W1 is the open room and W3 has unread messages; W2 folds away.
	expect(drawerRows()).toEqual([
		"fg-home",
		"fg-pin",
		"fg-w1",
		"fg-w3",
		"fg-free",
		"fg-team",
	]);
	expect(folded()).toEqual([F1]);
	// The same folder's fold is the room list's: one device, one fold.
	const search = q(".switcher-search input") as HTMLInputElement;
	await page.act(() => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(search, "w2");
		search.dispatchEvent(new Event("input", { bubbles: true }));
	});
	expect(drawerRows()).toEqual(["fg-w2"]);
	await page.act(() => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(search, "");
		search.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await page.click(heading("Pinned"));
	expect(drawerRows()).not.toContain("fg-pin");
	expect(folded().sort()).toEqual([F1, sectionFold("pinned")].sort());
	seedUnread({ [W3]: 0 });
});

test("the drawer's Waiting and Home groups never fold, and with one group there is no heading to fold", async () => {
	load({ folders: [WORK] });
	const card: PromptFrame = {
		id: "fg-p2",
		kind: "approval",
		title: "Run it?",
		message: "Run",
		purpose: "action",
	};
	store.dispatch({ type: "prompt", room: W2, prompt: card });
	await openDrawer(W1);
	// A group with no room is only a place to drop, and has no heading to fold.
	const headings = all("section:not([data-empty]) > .switcher-heading");
	expect(headings.length).toBeGreaterThan(2);
	for (const one of headings) {
		const waiting = one.hasAttribute("data-waiting");
		const home = one.textContent === "Home";
		expect(one.querySelector(".fold-toggle") === null).toBe(waiting || home);
	}
	store.dispatch({
		type: "prompt_closed",
		prompt: "fg-p2",
		outcome: "approved",
	});
});
