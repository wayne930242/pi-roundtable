import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { partial } from "pi-roundtable/testing";
import type { RoomView } from "../src/api-types.ts";
import { GroupTable } from "./components/group-table.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { loadKit } from "./lib/kit.ts";
import { setLook } from "./lib/look.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
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
let messages: ReturnType<typeof spyOn> | undefined;

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
	// whatever the test left in place, even when it failed half way
	messages?.mockRestore();
	messages = undefined;
	await page.render(<></>);
	portrait = false;
	calm = false;
	setLook(undefined);
	load([]);
	window.location.hash = "";
});
afterAll(async () => {
	window.matchMedia = realMatchMedia;
	setConnection(undefined);
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

test("clicking a seat turns the table to that agent: the address becomes #/table/<agent>", async () => {
	load(agents(3));
	await page.render(<TablePage />);
	await settle();
	const seat = query<SVGGElement>('g.seat[aria-label^="scout"]');
	expect(seat).not.toBeNull();
	seat?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	expect(decodeURIComponent(window.location.hash)).toBe("#/table/scout");
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
	expect(decodeURIComponent(window.location.hash)).toBe("#/table/scout");
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
	await page.render(
		<GroupTable
			roomKey="app:group.crew"
			scene={false}
			onScene={() => undefined}
		/>,
	);
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

test("under modern the strip is collapsed, and the Table button switches the room to the scene and back", async () => {
	setLook("modern");
	load([...agents(3), group(["scout", "mason"])]);
	const asked: boolean[] = [];
	await page.render(
		<GroupTable
			roomKey="app:group.crew"
			scene={false}
			onScene={(on) => void asked.push(on)}
		/>,
	);
	await settle();
	expect(query('[data-variant="compact"]')).toBeNull();
	const toggle = all<HTMLButtonElement>("button").find((button) =>
		button.textContent?.includes("Table"),
	);
	expect(toggle?.getAttribute("aria-pressed")).toBe("false");
	await page.click(toggle ?? null);
	expect(asked).toEqual([true]);
	await page.render(
		<GroupTable
			roomKey="app:group.crew"
			scene
			onScene={(on) => void asked.push(on)}
		/>,
	);
	const pressed = all<HTMLButtonElement>("button").find((button) =>
		button.textContent?.includes("Table"),
	);
	expect(pressed?.getAttribute("aria-pressed")).toBe("true");
	await page.click(pressed ?? null);
	expect(asked).toEqual([true, false]);
});

test("in the scene a group's strip is gone: the camera is the table", async () => {
	setLook("camelot");
	load([...agents(3), group(["scout", "mason"])]);
	await page.render(
		<GroupTable roomKey="app:group.crew" scene onScene={() => undefined} />,
	);
	await settle();
	expect(query('[data-variant="compact"]')).toBeNull();
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

test("the seat pictures are frameless figures and carry no id that two of them could share", async () => {
	load(agents(4));
	await page.render(<TablePage />);
	await settle();
	const ids = all("image").flatMap((image) => {
		const href = image.getAttribute("href") ?? "";
		const svg = decodeURIComponent(href.slice(href.indexOf(",") + 1));
		return [...svg.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
	});
	expect(all("image")).toHaveLength(4);
	expect(new Set(ids).size).toBe(ids.length);
	for (const image of all("image")) {
		const href = image.getAttribute("href") ?? "";
		expect(decodeURIComponent(href)).not.toContain('class="frame"');
	}
});

test("without WebGL the ring is the 2D hall: standees cut out with a rim, gold plates that letter Chinese, and the focused seat marked", async () => {
	load([
		agent("guide", { displayName: "\u9a0e\u58eb" }),
		agent("scout"),
		agent("mason"),
	]);
	messages = spyOn(api, "messages").mockResolvedValue({
		messages: [],
		more: false,
		cards: [],
	});
	setConnection(
		partial<AppConnection>({
			send: () => true,
			focus: () => undefined,
			say: () => undefined,
		}),
	);
	await page.render(
		<ConfigContext.Provider
			value={{
				title: "Console",
				panes: ["table"],
				timeZone: "UTC",
				look: "modern",
			}}
		>
			<TablePage focus="scout" />
		</ConfigContext.Provider>,
	);
	await settle();
	expect(query(".t2d")).not.toBeNull();
	expect(query("canvas")).toBeNull();
	for (const image of all("image"))
		expect(image.getAttribute("filter")).toMatch(/^url\(#t2d\d+-rim\)$/);
	expect(query("filter feMorphology")).not.toBeNull();
	const plates = all<SVGTextElement>("g.seat text").map(
		(text) => text.textContent,
	);
	expect(plates).toContain("\u9a0e\u58eb");
	expect(
		all("g.seat text").every((text) =>
			(text.getAttribute("font-family") ?? "").includes("PingFang TC"),
		),
	).toBe(true);
	expect(
		all("g.seat[data-focus]").map((seat) => seat.getAttribute("aria-label")),
	).toEqual(["scout (idle)"]);
	expect(query(".t2d")?.classList.contains("focus")).toBe(true);
});
