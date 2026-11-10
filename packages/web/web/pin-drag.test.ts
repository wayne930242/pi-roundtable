import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import type { Lift, Outcome } from "./lib/drag.ts";
import { liftPin } from "./lib/pin-drag.ts";

// happy-dom has no layout, so each pin is given the box it would have in a grid of three.
let page: TestPage;
beforeAll(async () => {
	page = await openPage();
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});
afterEach(() => {
	document.body.replaceChildren();
});

const box = (
	el: Element,
	left: number,
	top: number,
	width = 80,
	height = 100,
) => {
	el.getBoundingClientRect = () =>
		({
			top,
			bottom: top + height,
			left,
			right: left + width,
			width,
			height,
			x: left,
			y: top,
			toJSON: () => ({}),
		}) as DOMRect;
};
const pointer = (type: string, x: number, y: number, id = 1) => {
	const event = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		clientX: x,
		clientY: y,
	});
	Object.defineProperty(event, "pointerId", { value: id });
	window.dispatchEvent(event);
};
const frames = () => new Promise((resolve) => setTimeout(resolve, 30));

/** Pins A B C on the first row and D under A. */
function pins() {
	const root = document.createElement("ul");
	root.className = "pins";
	const items: Record<string, HTMLElement> = {};
	for (const [key, left, top] of [
		["A", 0, 0],
		["B", 100, 0],
		["C", 200, 0],
		["D", 0, 120],
	] as const) {
		const li = document.createElement("li");
		li.setAttribute("data-pin-item", "");
		li.dataset.key = key;
		box(li, left, top);
		root.append(li);
		items[key] = li;
	}
	document.body.append(root);
	box(root, 0, 0, 280, 220);
	return { root, items };
}

const start = (item: HTMLElement, root: HTMLElement, x: number, y: number) => {
	const done: Outcome[] = [];
	const options: Lift = {
		mode: "pin",
		item,
		key: item.dataset.key ?? "",
		pointerId: 1,
		x,
		y,
		root,
		open: () => undefined,
		done: (outcome) => done.push(outcome),
	};
	return { stop: liftPin(options), done };
};

test("a lifted pin follows the finger both ways, the pins after it move over, and the drop names the pin it goes before", async () => {
	const { root, items } = pins();
	const run = start(items.A as HTMLElement, root, 40, 50);
	expect(items.A?.hasAttribute("data-lifted")).toBe(true);
	expect(root.hasAttribute("data-reordering")).toBe(true);
	// Over C: A lands after C, so B and C each move one slot back.
	pointer("pointermove", 240, 50);
	await frames();
	expect(items.A?.style.transform).toBe("translate3d(200px, 0px, 0)");
	expect(items.B?.style.transform).toBe("translate3d(-100px, 0px, 0)");
	expect(items.C?.style.transform).toBe("translate3d(-100px, 0px, 0)");
	expect(items.D?.style.transform).toBe("");
	pointer("pointerup", 240, 50);
	expect(run.done).toEqual([{ type: "pin", before: "D" }]);
	// Everything painted is taken away.
	expect(items.A?.hasAttribute("data-lifted")).toBe(false);
	for (const one of Object.values(items)) expect(one.style.transform).toBe("");
	expect(root.hasAttribute("data-reordering")).toBe(false);
});

test("a pin dropped on the next row's end lands last", async () => {
	const { root, items } = pins();
	const run = start(items.B as HTMLElement, root, 140, 50);
	pointer("pointermove", 40, 170);
	await frames();
	expect(items.D?.style.transform).toBe("translate3d(200px, -120px, 0)");
	pointer("pointerup", 40, 170);
	expect(run.done).toEqual([{ type: "pin", before: null }]);
});

test("letting go without moving is a tap; back over its own slot, far outside, or Escape cancels", async () => {
	const { root, items } = pins();
	let run = start(items.A as HTMLElement, root, 40, 50);
	pointer("pointerup", 44, 52);
	expect(run.done).toEqual([{ type: "tap" }]);
	run = start(items.A as HTMLElement, root, 40, 50);
	pointer("pointermove", 140, 50);
	pointer("pointermove", 45, 60);
	await frames();
	pointer("pointerup", 45, 60);
	expect(run.done).toEqual([{ type: "cancel" }]);
	run = start(items.A as HTMLElement, root, 40, 50);
	pointer("pointermove", 140, 600);
	await frames();
	pointer("pointerup", 140, 600);
	expect(run.done).toEqual([{ type: "cancel" }]);
	run = start(items.A as HTMLElement, root, 40, 50);
	pointer("pointermove", 140, 50);
	window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
	expect(run.done).toEqual([{ type: "cancel" }]);
	expect(items.B?.style.transform).toBe("");
});

test("another finger's events are ignored", async () => {
	const { root, items } = pins();
	const run = start(items.A as HTMLElement, root, 40, 50);
	pointer("pointermove", 240, 50, 2);
	pointer("pointerup", 240, 50, 2);
	expect(run.done).toEqual([]);
	run.stop();
	expect(run.done).toEqual([{ type: "cancel" }]);
});
