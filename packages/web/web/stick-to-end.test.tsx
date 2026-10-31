import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { useRef } from "react";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { useStickToEnd } from "./lib/stick-to-end.ts";

let page: TestPage;
beforeAll(async () => {
	page = await openPage();
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});

/** The hook's controls, for the tests to call as the scroller and its content would. */
let hook: ReturnType<typeof useStickToEnd>;

function Log() {
	const scroller = useRef<HTMLDivElement>(null);
	hook = useStickToEnd(scroller);
	return (
		<div id="log" ref={scroller} onScroll={hook.onScroll}>
			{hook.away ? <span id="away" /> : null}
		</div>
	);
}

const log = (): HTMLElement => {
	const found = document.getElementById("log");
	if (!found) throw new Error("no log");
	return found;
};
const away = () => document.getElementById("away") !== null;

/** happy-dom lays nothing out: the log is 500px tall and `height` long. */
let height = 2000;
function lay(element: HTMLElement): void {
	Object.defineProperty(element, "clientHeight", {
		configurable: true,
		value: 500,
	});
	Object.defineProperty(element, "scrollHeight", {
		configurable: true,
		get: () => height,
	});
	element.scrollTo = ((options: ScrollToOptions) => {
		element.scrollTop = Math.min(
			options.top ?? element.scrollTop,
			height - 500,
		);
	}) as typeof element.scrollTo;
}

/** The scroller moved to `top`: the browser sets it and sends a scroll event. */
const scrollTo = (top: number) =>
	page.act(() => {
		log().scrollTop = top;
		log().dispatchEvent(new Event("scroll"));
	});

/** The content changed height, as the ResizeObserver reports it. */
const grow = (to: number) =>
	page.act(() => {
		height = to;
		hook.onGrow();
	});

const END = 1500;

beforeEach(async () => {
	await page.render(null);
	await page.render(<Log />);
	height = 2000;
	lay(log());
	await page.act(() => hook.toEnd(false));
	await scrollTo(END);
});

test("a wheel toward the start leaves the end at once, so content growing a few pixels up does not pull the person back", async () => {
	await page.act(() => {
		log().dispatchEvent(new WheelEvent("wheel", { deltaY: -30 }));
	});
	await scrollTo(END - 30);
	await grow(2300);
	expect(log().scrollTop).toBe(END - 30);
	expect(away()).toBe(true);
});

test("a scroll up without a wheel, such as the scrollbar dragged, also leaves the end, however near it stays", async () => {
	await scrollTo(END - 20);
	await grow(2300);
	expect(log().scrollTop).toBe(END - 20);
});

test("a finger dragging the content down, or a key toward the start, leaves the end", async () => {
	await page.act(() => {
		log().dispatchEvent(
			new TouchEvent("touchstart", {
				touches: [{ clientY: 100 } as unknown as Touch],
			}),
		);
		log().dispatchEvent(
			new TouchEvent("touchmove", {
				touches: [{ clientY: 140 } as unknown as Touch],
			}),
		);
	});
	await grow(2300);
	expect(log().scrollTop).toBe(END);
	await page.act(() => hook.toEnd(false));
	expect(log().scrollTop).toBe(1800);
	await page.act(() => {
		log().dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp" }));
	});
	await grow(2600);
	expect(log().scrollTop).toBe(1800);
});

test("rows settling above while the person reads are not their scroll and do not bring the end back", async () => {
	await scrollTo(1000);
	// A row above lays out taller: the height changes and the browser keeps the view in place.
	await page.act(() => {
		height = 2400;
		log().scrollTop = 1400;
		log().dispatchEvent(new Event("scroll"));
	});
	await grow(2400);
	expect(log().scrollTop).toBe(1400);
	expect(away()).toBe(true);
});

test("scrolling back down near the end follows it again, and so does the newest button", async () => {
	await scrollTo(1000);
	await scrollTo(1450);
	await grow(2200);
	expect(log().scrollTop).toBe(1700);
	expect(away()).toBe(false);
	await scrollTo(1000);
	await page.act(() => hook.toEnd(false));
	await grow(2500);
	expect(log().scrollTop).toBe(2000);
});

test("at the end, content growing keeps the end in view", async () => {
	await grow(2200);
	expect(log().scrollTop).toBe(1700);
	await grow(2400);
	expect(log().scrollTop).toBe(1900);
	expect(away()).toBe(false);
});
