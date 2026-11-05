import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	test,
} from "bun:test";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import {
	attachRowSwipe,
	PULL_ARM,
	pullTravel,
	type RowSwipe,
} from "./lib/row-swipe.ts";

let page: TestPage;
let reduced = false;
let unread = true;
let acted = 0;
let swipe: RowSwipe;
let row: HTMLElement;
let reveal: HTMLElement;
const realMatchMedia = globalThis.matchMedia;

beforeAll(async () => {
	page = await openPage();
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});
beforeEach(() => {
	window.innerWidth = 390;
	reduced = false;
	unread = true;
	acted = 0;
	Object.defineProperty(globalThis, "matchMedia", {
		value: (query: string) => ({
			matches: reduced && query.includes("reduce"),
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
		}),
		configurable: true,
	});
	const item = document.createElement("li");
	reveal = document.createElement("span");
	reveal.className = "read-reveal";
	row = document.createElement("a");
	row.className = "row";
	Object.defineProperty(row, "offsetWidth", { value: 360 });
	item.append(reveal, row);
	page.container.append(item);
	swipe = attachRowSwipe(page.container, {
		row: ".row",
		can: () => unread,
		act: () => {
			acted += 1;
		},
		leaves: false,
		reveal: () => reveal,
	});
});
afterEach(() => {
	swipe.detach();
	page.container.replaceChildren();
	Object.defineProperty(globalThis, "matchMedia", {
		value: realMatchMedia,
		configurable: true,
	});
});

function touch(type: string, x: number): void {
	row.dispatchEvent(
		new PointerEvent(type, {
			bubbles: true,
			cancelable: true,
			clientX: x,
			clientY: 100,
			pointerId: 3,
			pointerType: "touch",
			isPrimary: true,
		}),
	);
}
/** A finger from 40 to `to`, at once, then still down. */
function pull(to: number): void {
	touch("pointerdown", 40);
	for (let i = 1; i <= 8; i += 1)
		touch("pointermove", 40 + ((to - 40) * i) / 8);
}
/** Lets go at `x` after resting `rest` ms; a quick lift is a flick. */
async function lift(x: number, rest = 150): Promise<void> {
	if (rest) await new Promise((resolve) => setTimeout(resolve, rest));
	touch("pointerup", x);
}
const travel = () =>
	Number.parseFloat(
		row.style.transform.replace(/translate3d\(([\d.]+)px.*/, "$1"),
	);

test("travel is half the finger's way, then rubber, and never passes the cap", async () => {
	expect(pullTravel(40)).toBe(20);
	expect(pullTravel(100)).toBe(50);
	let last = 0;
	for (const finger of [140, 200, 400, 1000, 10_000]) {
		const at = pullTravel(finger);
		expect(at).toBeGreaterThanOrEqual(last);
		expect(at).toBeLessThanOrEqual(80);
		last = at;
	}
	pull(2000);
	expect(travel()).toBeLessThanOrEqual(80);
	expect(travel()).toBeGreaterThan(PULL_ARM);
	await lift(2000);
});

test("the row and its mark arm past the threshold of travel, not before, and disarm when pulled back", async () => {
	// 12 px of intent, then twice the travel: 100 px of finger is 44 px of travel.
	pull(140);
	expect(travel()).toBeLessThan(PULL_ARM);
	expect(row.hasAttribute("data-armed")).toBe(false);
	expect(reveal.hasAttribute("data-shown")).toBe(true);
	expect(reveal.hasAttribute("data-armed")).toBe(false);
	touch("pointermove", 180);
	expect(travel()).toBeGreaterThanOrEqual(PULL_ARM);
	expect(row.hasAttribute("data-armed")).toBe(true);
	expect(reveal.hasAttribute("data-armed")).toBe(true);
	touch("pointermove", 150);
	expect(row.hasAttribute("data-armed")).toBe(false);
	expect(reveal.hasAttribute("data-armed")).toBe(false);
	await lift(150);
	expect(acted).toBe(0);
});

test("let go armed, the row acts once and springs back to rest, with no slide-out", async () => {
	pull(260);
	await lift(260);
	expect(acted).toBe(1);
	expect(row.style.transform).toBe("");
	expect(row.style.transition).toBe("transform 180ms var(--ease-out)");
	expect(row.style.opacity).toBe("");
	expect(row.hasAttribute("data-armed")).toBe(false);
	expect(reveal.hasAttribute("data-shown")).toBe(false);
	expect(reveal.hasAttribute("data-armed")).toBe(false);
	expect(swipe.swallowing).toBe(true);
});

test("a short pull does nothing; a short flick acts", async () => {
	pull(120);
	await lift(120);
	expect(acted).toBe(0);
	expect(row.style.transform).toBe("");
	pull(120);
	await lift(120, 0);
	expect(acted).toBe(1);
});

test("the row springs back at once for someone who asked for less motion", async () => {
	reduced = true;
	pull(260);
	await lift(260);
	expect(acted).toBe(1);
	expect(row.style.transition).toContain("0ms");
});

test("a row that cannot act only gives a little and shows nothing", async () => {
	unread = false;
	pull(400);
	expect(travel()).toBeLessThanOrEqual(24);
	expect(reveal.hasAttribute("data-shown")).toBe(false);
	await lift(400, 0);
	expect(acted).toBe(0);
});
