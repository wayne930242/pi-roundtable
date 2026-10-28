import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { RoomView } from "../src/api-types.ts";
import { GroupTable } from "./components/group-table.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { store } from "./lib/app-store.ts";
import { loadKit } from "./lib/kit.ts";
import { setLook } from "./lib/look.ts";
import { TablePage } from "./pages/table.tsx";

const NAMES = [
	"guide",
	"scout",
	"mason",
	"cook",
	"nurse",
	"pilot",
	"smith",
	"baker",
	"clerk",
	"diver",
	"actor",
	"elder",
];

const agent = (name: string, over: Partial<RoomView> = {}): RoomView => ({
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

const group = (members: string[], over: Partial<RoomView> = {}): RoomView => ({
	key: "app:group.crew",
	kind: "group",
	name: "crew",
	displayName: "Crew",
	home: false,
	readOnly: false,
	members,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
	...over,
});

const load = (rooms: RoomView[]) =>
	store.dispatch({ type: "rooms_loaded", rooms });
const agents = (count: number) => NAMES.slice(0, count).map((n) => agent(n));

let portrait = false;
let calm = false;
const realMatchMedia = globalThis.matchMedia;
let page: TestPage;

beforeAll(async () => {
	await loadKit();
	page = await openPage();
	// A phone held upright, and nothing else the page asks about.
	window.matchMedia = ((query: string) => ({
		matches: query.includes("orientation: portrait")
			? portrait
			: query.includes("prefers-reduced-motion")
				? calm
				: false,
		media: query,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		addListener: () => undefined,
		removeListener: () => undefined,
		dispatchEvent: () => false,
		onchange: null,
	})) as typeof window.matchMedia;
});
afterEach(async () => {
	await page.render(<></>);
	portrait = false;
	calm = false;
	setLook(undefined);
	load([]);
	window.location.hash = "";
});
afterAll(async () => {
	window.matchMedia = realMatchMedia;
	await page.unmount();
	await releaseDom();
});

/** The table mounts through a lazy chunk and a promise; give both time. */
const settle = () =>
	page.act(() => new Promise((done) => setTimeout(done, 60)));
const query = <T extends Element>(selector: string): T | null =>
	page.container.querySelector<T>(selector);
const all = <T extends Element>(selector: string): T[] => [
	...page.container.querySelectorAll<T>(selector),
];

test("clicking a seat opens that agent's room", async () => {
	load(agents(3));
	await page.render(<TablePage />);
	await settle();
	const seat = query<SVGGElement>('g.seat[aria-label^="scout"]');
	expect(seat).not.toBeNull();
	seat?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	expect(decodeURIComponent(window.location.hash)).toBe(
		"#/room/app:agent.scout",
	);
});

test("the coordinator sits first in the seat list, whatever the list's order", async () => {
	portrait = true;
	load([...NAMES.slice(1, 12).map((n) => agent(n)), agent("guide")]);
	await page.render(<TablePage />);
	await settle();
	const names = all<HTMLButtonElement>(".rt-table-list button").map(
		(button) => button.textContent,
	);
	expect(names).toHaveLength(12);
	expect(names[0]).toBe("guide (idle)");
});

test("the seat pictures go in as data URIs, one per seat", async () => {
	load(agents(3));
	await page.render(<TablePage />);
	await settle();
	const hrefs = all("image").map((image) => image.getAttribute("href") ?? "");
	expect(hrefs).toHaveLength(3);
	for (const href of hrefs) expect(href).toStartWith("data:image/svg+xml");
	expect(new Set(hrefs).size).toBe(3);
});

test("portrait with 11 seats shows the seat list under the table", async () => {
	portrait = true;
	load(agents(11));
	await page.render(<TablePage />);
	await settle();
	const buttons = all<HTMLButtonElement>(".rt-table-list button");
	expect(buttons).toHaveLength(11);
	buttons[1]?.click();
	expect(decodeURIComponent(window.location.hash)).toBe(
		"#/room/app:agent.scout",
	);
});

test("portrait with 10 seats, or landscape with 11, needs no list", async () => {
	portrait = true;
	load(agents(10));
	await page.render(<TablePage />);
	await settle();
	expect(query(".rt-table-list")).toBeNull();
	portrait = false;
	await page.render(<></>);
	load(agents(11));
	await page.render(<TablePage />);
	await settle();
	expect(query(".rt-table-list")).toBeNull();
});

test("under Camelot a group room renders the compact strip, lit on its speaker", async () => {
	setLook("camelot");
	load([
		...agents(3),
		group(["scout", "mason"], { typing: true, agent: "mason" }),
	]);
	await page.render(<GroupTable roomKey="app:group.crew" />);
	await settle();
	expect(query('[data-variant="compact"]')).not.toBeNull();
	const states = Object.fromEntries(
		all("g.seat").map((seat) => [
			seat.getAttribute("aria-label")?.split(" ")[0],
			seat.getAttribute("data-state"),
		]),
	);
	// Only the group's members sit in the strip, and the one the round names speaks.
	expect(states).toEqual({ scout: "idle", mason: "speaking" });
});

test("under modern the strip is collapsed, and the Table button opens only the members", async () => {
	setLook("modern");
	load([...agents(3), group(["scout", "mason"])]);
	await page.render(<GroupTable roomKey="app:group.crew" />);
	await settle();
	expect(query('[data-variant="compact"]')).toBeNull();
	const open = all<HTMLButtonElement>("button").find((button) =>
		button.textContent?.includes("Table"),
	);
	expect(open).toBeDefined();
	await page.click(open ?? null);
	await settle();
	expect(query('[data-variant="full"]')).not.toBeNull();
	expect(all("g.seat")).toHaveLength(2);
});

test("a seat's picture is drawn again once its face changes, and not before 300 ms", async () => {
	load(agents(3));
	await page.render(<TablePage />);
	await settle();
	const picture = () =>
		query<SVGImageElement>('g.seat[aria-label^="scout"] image')?.getAttribute(
			"href",
		);
	const idle = picture();
	expect(idle).toStartWith("data:image/svg+xml");
	await page.act(() =>
		store.dispatch({
			type: "activity",
			room: "app:agent.scout",
			typing: true,
			stoppable: true,
			phase: "working",
		}),
	);
	// The seat's state moves at once; its face waits.
	expect(query('g.seat[aria-label^="scout"]')?.getAttribute("data-state")).toBe(
		"working",
	);
	expect(picture()).toBe(idle);
	await page.act(() => new Promise((done) => setTimeout(done, 400)));
	const working = picture();
	expect(working).toStartWith("data:image/svg+xml");
	expect(working).not.toBe(idle);
});

test("under reduced motion the table stands still, and the seat pictures carry no live overlays", async () => {
	calm = true;
	load(agents(3));
	await page.render(<TablePage />);
	await settle();
	expect(query(".t2d")?.classList.contains("reduced")).toBe(true);
	// Drawn still: the picture holds its one face, never the live character's overlays.
	const href =
		query<SVGImageElement>("g.seat image")?.getAttribute("href") ?? "";
	const svg = decodeURIComponent(href.slice(href.indexOf(",") + 1));
	expect(svg).toContain('class="av static"');
	expect(svg).not.toContain('class="ov ');
});

test("every seat picture in the table has its own ids", async () => {
	load(agents(4));
	await page.render(<TablePage />);
	await settle();
	const ids = all("image").flatMap((image) => {
		const href = image.getAttribute("href") ?? "";
		const svg = decodeURIComponent(href.slice(href.indexOf(",") + 1));
		return [...svg.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
	});
	expect(ids.length).toBeGreaterThanOrEqual(4);
	expect(new Set(ids).size).toBe(ids.length);
});
