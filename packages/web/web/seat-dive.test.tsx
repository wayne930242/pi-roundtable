import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { partial } from "pi-roundtable/testing";
import type { RoomView } from "../src/api-types.ts";
import { type AnimationStub, stubAnimations } from "./animation-stub.ts";
import { RoundTable } from "./components/round-table.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { store } from "./lib/app-store.ts";
import { loadKit } from "./lib/kit.ts";
import { setRouting } from "./lib/router.ts";
import { DIVE_EASE, DIVE_MS, diving } from "./lib/seat-dive.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";

// A tap on a seat dives into it, the room opens once when the zoom ends, and anything that
// interrupts the zoom gives the view back and opens nothing.

const agent = (name: string): RoomView => ({
	key: `app:agent.${name}`,
	kind: "agent",
	name,
	displayName: name,
	home: name === "guide",
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
});

let calm = false;
const realMatchMedia = globalThis.matchMedia;
let page: TestPage;
let motion: AnimationStub;

beforeAll(async () => {
	await loadKit();
	page = await openPage();
	setRouting(undefined);
	setConnection(partial<AppConnection>({ send: () => true }));
	window.matchMedia = ((query: string) => ({
		matches: query.includes("prefers-reduced-motion") ? calm : false,
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
	motion?.restore();
	await page.render(<></>);
	calm = false;
	store.dispatch({ type: "rooms_loaded", rooms: [] });
	window.location.hash = "";
	document.documentElement.removeAttribute("data-dive");
});
afterAll(async () => {
	window.matchMedia = realMatchMedia;
	setConnection(undefined);
	await page.unmount();
	await releaseDom();
});

const wait = (ms = 60) =>
	page.act(() => new Promise((done) => setTimeout(done, ms)));
const route = (): HTMLElement => {
	const main = page.container.querySelector<HTMLElement>("main.route");
	if (!main) throw new Error("no route");
	return main;
};
const seat = (name: string) =>
	page.container.querySelector<SVGGElement>(`g.seat[aria-label^="${name}"]`);

async function shown(auto = false) {
	motion = stubAnimations(auto);
	store.dispatch({
		type: "rooms_loaded",
		rooms: [agent("guide"), agent("scout"), agent("mason")],
	});
	await page.render(
		<main className="route">
			<RoundTable />
		</main>,
	);
	await wait();
}
const tap = (name: string, at = { clientX: 120, clientY: 80 }) =>
	page.act(() => {
		seat(name)?.dispatchEvent(
			new MouseEvent("click", { bubbles: true, detail: 1, ...at }),
		);
	});
const room = () => decodeURIComponent(window.location.hash);

test("a tap on a seat zooms the view toward it with a slow-then-sharp curve, and opens the room once when the zoom ends", async () => {
	await shown();
	await tap("scout");
	const [zoom] = motion.animations;
	expect(motion.animations).toHaveLength(1);
	expect(zoom?.target).toBe(route());
	expect(zoom?.options.easing).toBe(DIVE_EASE);
	expect(zoom?.options.duration).toBe(DIVE_MS);
	expect(DIVE_MS).toBeGreaterThanOrEqual(300);
	expect(DIVE_MS).toBeLessThanOrEqual(450);
	// Transform and opacity only, about the point that was tapped.
	for (const frame of zoom?.keyframes ?? [])
		expect(Object.keys(frame).sort()).toEqual([
			"opacity",
			"transform",
			"transformOrigin",
		]);
	expect(zoom?.keyframes[0]?.transformOrigin).toBe(
		`${120 - route().getBoundingClientRect().left}px ${80 - route().getBoundingClientRect().top}px`,
	);
	// The room waits for the zoom, and the view takes no second tap meanwhile.
	expect(room()).toBe("");
	expect(diving()).toBe(true);
	expect(route().style.pointerEvents).toBe("none");
	zoom?.finish();
	await wait();
	expect(room()).toBe("#/room/app:agent.scout");
	// The last frame is held while the route commits, and the router makes no transition of its own.
	expect(diving()).toBe(true);
	expect(document.documentElement.hasAttribute("data-dive")).toBe(true);
	await page.render(<main className="route">room</main>);
	await wait();
	expect(diving()).toBe(false);
	expect(document.documentElement.hasAttribute("data-dive")).toBe(false);
});

test("a route that never commits gives the view back", async () => {
	await shown();
	await tap("scout");
	motion.animations[0]?.finish();
	await wait(800);
	expect(diving()).toBe(false);
	expect(document.documentElement.hasAttribute("data-dive")).toBe(false);
	expect(route().style.pointerEvents).toBe("");
	expect(motion.animations[0]?.cancelled).toBe(true);
});

test("a second tap during the zoom is dropped: the room opens once, for the first seat", async () => {
	await shown();
	let hashes = 0;
	window.addEventListener("hashchange", () => hashes++);
	await tap("scout");
	await tap("mason");
	expect(motion.animations).toHaveLength(1);
	motion.animations[0]?.finish();
	await wait();
	expect(room()).toBe("#/room/app:agent.scout");
	expect(hashes).toBeLessThanOrEqual(1);
});

test("a key press on a seat dives from the middle of the seat", async () => {
	await shown();
	await page.act(() => {
		seat("mason")?.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
		);
	});
	expect(motion.animations).toHaveLength(1);
	motion.animations[0]?.finish();
	await wait();
	expect(room()).toBe("#/room/app:agent.mason");
});

test("under reduced motion the room opens at once, with no zoom", async () => {
	calm = true;
	await shown();
	await tap("scout");
	expect(motion.animations).toHaveLength(0);
	expect(room()).toBe("#/room/app:agent.scout");
	expect(diving()).toBe(false);
});

test("Back during the zoom gives the view back and opens nothing", async () => {
	await shown();
	await tap("scout");
	const [zoom] = motion.animations;
	expect(diving()).toBe(true);
	window.dispatchEvent(new PopStateEvent("popstate"));
	expect(zoom?.cancelled).toBe(true);
	expect(diving()).toBe(false);
	expect(route().style.pointerEvents).toBe("");
	expect(route().style.overflow).toBe("");
	// The zoom that ended after being cancelled opens nothing.
	zoom?.finish();
	await wait();
	expect(room()).toBe("");
	// And the table takes a tap again.
	await tap("mason");
	expect(motion.animations).toHaveLength(2);
});

test("the table leaving the page during the zoom drops the dive", async () => {
	await shown();
	await tap("scout");
	const [zoom] = motion.animations;
	await page.render(<></>);
	expect(zoom?.cancelled).toBe(true);
	expect(diving()).toBe(false);
	zoom?.finish();
	await wait();
	expect(room()).toBe("");
});

test("the room that opens settles in, and the held view is given back", async () => {
	await shown();
	await tap("scout");
	motion.animations[0]?.finish();
	// The route commits: the table's page is replaced by the room's.
	await page.render(<main className="route">room</main>);
	await wait();
	const settle = motion.animations[1];
	expect(settle?.target).toBe(route());
	expect(settle?.keyframes.at(-1)?.opacity).toBe(1);
	expect(diving()).toBe(false);
});
