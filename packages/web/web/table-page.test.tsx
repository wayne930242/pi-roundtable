import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { partial } from "pi-roundtable/testing";
import type { ConfigView, RoomView } from "../src/api-types.ts";
import { CouncilView } from "./components/council-view.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { resetCouncilModes, setCouncilMode } from "./lib/council-mode.ts";
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
/** Waits until the 2D hall has drawn the seat of this agent: the first table of a run loads its chunk first. */
const seatOf = async (name: string): Promise<SVGGElement | null> => {
	for (let tries = 0; tries < 30; tries += 1) {
		const found = query<SVGGElement>(`g.seat[aria-label^="${name}"]`);
		if (found) return found;
		await settle();
	}
	return null;
};

/** Waits, in steps of the table's own pace, until the 2D hall shows what a click asked of the camera. */
const focused = async (): Promise<(string | null)[]> => {
	const marked = () =>
		all("g.seat[data-focus]").map((seat) => seat.getAttribute("aria-label"));
	for (let tries = 0; tries < 30 && marked().length === 0; tries += 1)
		await settle();
	return marked();
};
const query = <T extends Element>(selector: string): T | null =>
	page.container.querySelector<T>(selector);
const all = <T extends Element>(selector: string): T[] => [
	...page.container.querySelectorAll<T>(selector),
];

/** The owner's table is a council: the agents are seated through a group, and its room answers in the box. */
const CONFIG: ConfigView = {
	title: "Console",
	panes: ["table"],
	timeZone: "UTC",
	look: "modern",
};
const renderTable = () =>
	page.render(
		<ConfigContext.Provider value={CONFIG}>
			<TablePage />
		</ConfigContext.Provider>,
	);

const seatCouncil = async (count: number, over: Partial<RoomView> = {}) => {
	const list = agents(count);
	load([...list, group(NAMES.slice(0, count), over)]);
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
	await renderTable();
	await settle();
};

test("clicking a seat turns the camera to that knight and leaves the address as it was", async () => {
	await seatCouncil(3);
	const seat = await seatOf("scout");
	expect(seat).not.toBeNull();
	await page.act(() => {
		seat?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	expect(await focused()).toEqual(["scout (idle)"]);
	expect(window.location.hash).toBe("");
});

test("a council seats its members, the coordinator first, and no more than eight, with no +N seat", async () => {
	await seatCouncil(12);
	const seats = all("g.seat").map((seat) => seat.getAttribute("aria-label"));
	expect(seats).toHaveLength(8);
	expect(seats[0]).toBe("guide (idle)");
	expect(seats.some((label) => label?.startsWith("+"))).toBe(false);
});

test("an agent that is muted still sits when the council has it: mute only stops push", async () => {
	const list = agents(3).map((one) =>
		one.name === "scout" ? { ...one, muted: true as const } : one,
	);
	load([...list, group(["guide", "scout", "mason"])]);
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
	await renderTable();
	await settle();
	expect(all("g.seat")).toHaveLength(3);
});

test("an agent that is not in the council is not drawn", async () => {
	load([...agents(4), group(["guide", "scout"])]);
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
	await renderTable();
	await settle();
	expect(all("g.seat").map((seat) => seat.getAttribute("aria-label"))).toEqual([
		"guide (idle)",
		"scout (idle)",
	]);
});

test("the seat pictures go in as data URIs, one per seat", async () => {
	await seatCouncil(3);
	const hrefs = all("image").map((image) => image.getAttribute("href") ?? "");
	expect(hrefs).toHaveLength(3);
	for (const href of hrefs) expect(href).toStartWith("data:image/svg+xml");
	expect(new Set(hrefs).size).toBe(3);
});

test("upright, even with eight seats, no seat list stands under the table", async () => {
	portrait = true;
	await seatCouncil(8);
	expect(all("g.seat")).toHaveLength(8);
	expect(query(".rt-table-list")).toBeNull();
});

test("under Camelot a council in chat mode renders the compact strip, lit on its speaker", async () => {
	setLook("camelot");
	load([
		...agents(3),
		group(["scout", "mason"], { typing: true, agent: "mason" }),
	]);
	setCouncilMode("app:group.crew", "chat");
	messages = spyOn(api, "messages").mockResolvedValue({
		messages: [],
		more: false,
		cards: [],
	});
	await page.render(
		<ConfigContext.Provider value={CONFIG}>
			<CouncilView roomKey="app:group.crew" lead={null} />
		</ConfigContext.Provider>,
	);
	await settle();
	expect(query('[data-variant="compact"]')).not.toBeNull();
	const states = () =>
		Object.fromEntries(
			all("g.seat").map((seat) => [
				seat.getAttribute("aria-label")?.split(" ")[0],
				seat.getAttribute("data-state"),
			]),
		);
	// Only the group's members sit in the strip; the one whose turn runs thinks until its words come.
	expect(states()).toEqual({ scout: "idle", mason: "thinking" });
	// Its words stream into the room: it speaks.
	await page.act(() => {
		store.dispatch({ type: "focused", room: "app:group.crew" });
		store.dispatch({
			type: "progress",
			room: "app:group.crew",
			event: { type: "text", delta: "Here is what I found." },
		});
	});
	await settle();
	expect(states()).toEqual({ scout: "idle", mason: "speaking" });
	// the turn ends: what streamed goes with it, and so does the room's focus
	await page.act(() => {
		store.dispatch({
			type: "activity",
			room: "app:group.crew",
			typing: false,
			stoppable: false,
		});
		store.dispatch({ type: "focused", room: undefined });
	});
});

test("under modern a council in chat mode has no strip, and the mode switch shows the scene and back", async () => {
	setLook("modern");
	load([...agents(3), group(["scout", "mason"])]);
	setCouncilMode("app:group.crew", "chat");
	messages = spyOn(api, "messages").mockResolvedValue({
		messages: [],
		more: false,
		cards: [],
	});
	await page.render(
		<ConfigContext.Provider value={CONFIG}>
			<CouncilView roomKey="app:group.crew" lead={null} />
		</ConfigContext.Provider>,
	);
	await settle();
	expect(query('[data-variant="compact"]')).toBeNull();
	expect(query(".table-chat")).not.toBeNull();
	const radio = (mode: string) =>
		all<HTMLInputElement>('.table-mode input[type="radio"]').find(
			(one) => one.value === mode,
		) ?? null;
	await page.click(radio("scene"));
	await settle();
	expect(query(".table-chat")).toBeNull();
	expect(query(".room-scene")).not.toBeNull();
	await page.click(radio("chat"));
	await settle();
	expect(query(".table-chat")).not.toBeNull();
	resetCouncilModes();
});

test("in the scene a council's strip is gone: the camera is the table", async () => {
	setLook("camelot");
	load([...agents(3), group(["scout", "mason"])]);
	setCouncilMode("app:group.crew", "scene");
	messages = spyOn(api, "messages").mockResolvedValue({
		messages: [],
		more: false,
		cards: [],
	});
	await page.render(
		<ConfigContext.Provider value={CONFIG}>
			<CouncilView roomKey="app:group.crew" lead={null} />
		</ConfigContext.Provider>,
	);
	await settle();
	expect(query('[data-variant="compact"]')).toBeNull();
});

test("a seat's picture is drawn again once its face changes, and not before 300 ms", async () => {
	await seatCouncil(3);
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
	await seatCouncil(3);
	expect(query(".t2d")?.classList.contains("reduced")).toBe(true);
	// Drawn still: the picture holds its one face, never the live character's overlays.
	const href =
		query<SVGImageElement>("g.seat image")?.getAttribute("href") ?? "";
	const svg = decodeURIComponent(href.slice(href.indexOf(",") + 1));
	expect(svg).toContain('class="av static"');
	expect(svg).not.toContain('class="ov ');
});

test("the seat pictures are frameless figures and carry no id that two of them could share", async () => {
	await seatCouncil(4);
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
		group(["guide", "scout", "mason"]),
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
			<TablePage />
		</ConfigContext.Provider>,
	);
	const seat = await seatOf("scout");
	await page.act(() => {
		seat?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	expect(await focused()).toEqual(["scout (idle)"]);
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
	expect(query(".t2d")?.classList.contains("focus")).toBe(true);
});
