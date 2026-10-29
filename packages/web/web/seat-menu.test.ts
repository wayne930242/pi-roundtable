import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Clock } from "./lib/long-press.ts";
import { HOLD_MS } from "./lib/long-press.ts";
import { attachSeatMenu } from "./table/seat-menu.ts";
import type { SeatMenuRequest } from "./table/types.ts";

beforeAll(() => GlobalRegistrator.register({ width: 390, height: 844 }));
afterAll(() => GlobalRegistrator.unregister());

/** A clock the test moves by hand. */
function manualClock() {
	const pending = new Set<{ run: () => void; at: number }>();
	let now = 0;
	const clock: Clock = {
		set(run, ms) {
			const entry = { run, at: now + ms };
			pending.add(entry);
			return () => void pending.delete(entry);
		},
	};
	return {
		clock,
		advance(ms: number) {
			now += ms;
			for (const entry of [...pending])
				if (entry.at <= now) {
					pending.delete(entry);
					entry.run();
				}
		},
	};
}

function setup() {
	const root = document.createElement("div");
	const seat = document.createElement("button");
	seat.dataset.seat = "lena";
	const floor = document.createElement("div");
	root.append(seat, floor);
	document.body.append(root);
	const asked: SeatMenuRequest[] = [];
	const time = manualClock();
	const detach = attachSeatMenu(
		root,
		(target) =>
			target === seat || (target instanceof Element && seat.contains(target))
				? { id: "lena", name: "Lena" }
				: undefined,
		(request) => void asked.push(request),
		time.clock,
	);
	return { root, seat, floor, asked, time, detach };
}

const touch = (type: string, target: Element, x = 20, y = 30) =>
	target.dispatchEvent(
		new PointerEvent(type, {
			bubbles: true,
			cancelable: true,
			pointerId: 7,
			pointerType: "touch",
			isPrimary: true,
			clientX: x,
			clientY: y,
		}),
	);

test("a finger that rests on a seat opens its menu, and the click after the lift does not open the seat", () => {
	const { seat, asked, time, root } = setup();
	const clicks: string[] = [];
	root.addEventListener("click", () => clicks.push("seat"));
	touch("pointerdown", seat);
	time.advance(HOLD_MS - 1);
	expect(asked).toEqual([]);
	time.advance(1);
	expect(asked).toHaveLength(1);
	expect(asked[0]).toMatchObject({
		id: "lena",
		name: "Lena",
		via: "hold",
		at: { x: 20, y: 30 },
	});
	expect(asked[0]?.source).toBe(seat);
	touch("pointerup", seat);
	seat.click();
	expect(clicks).toEqual([]);
	// the next click is an ordinary one
	seat.click();
	expect(clicks).toEqual(["seat"]);
});

test("a finger that moves, lifts early, or rests on bare floor opens nothing", () => {
	const { seat, floor, asked, time } = setup();
	touch("pointerdown", seat);
	touch("pointermove", seat, 60, 30);
	time.advance(HOLD_MS * 2);
	touch("pointerup", seat, 60, 30);
	touch("pointerdown", seat);
	time.advance(HOLD_MS - 50);
	touch("pointerup", seat);
	time.advance(HOLD_MS * 2);
	touch("pointerdown", floor);
	time.advance(HOLD_MS * 2);
	expect(asked).toEqual([]);
});

test("a mouse never holds: it has the right button", () => {
	const { seat, asked, time } = setup();
	seat.dispatchEvent(
		new PointerEvent("pointerdown", {
			bubbles: true,
			pointerId: 1,
			pointerType: "mouse",
			isPrimary: true,
		}),
	);
	time.advance(HOLD_MS * 2);
	expect(asked).toEqual([]);
});

test("a right click on a seat opens the menu where it was, and one on bare floor is the browser's", () => {
	const { seat, floor, asked } = setup();
	const onSeat = new MouseEvent("contextmenu", {
		bubbles: true,
		cancelable: true,
		clientX: 11,
		clientY: 12,
	});
	seat.dispatchEvent(onSeat);
	expect(onSeat.defaultPrevented).toBe(true);
	expect(asked).toEqual([
		expect.objectContaining({
			id: "lena",
			via: "contextmenu",
			at: { x: 11, y: 12 },
		}),
	]);
	const onFloor = new MouseEvent("contextmenu", {
		bubbles: true,
		cancelable: true,
	});
	floor.dispatchEvent(onFloor);
	expect(onFloor.defaultPrevented).toBe(false);
	expect(asked).toHaveLength(1);
});

test("Android's contextmenu after a hold is answered once", () => {
	const { seat, asked, time } = setup();
	touch("pointerdown", seat);
	time.advance(HOLD_MS);
	seat.dispatchEvent(
		new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
	);
	expect(asked).toHaveLength(1);
});

test("the Menu key and Shift+F10 on a seat open the menu; other keys do not", () => {
	const { seat, asked } = setup();
	const key = (init: KeyboardEventInit) =>
		seat.dispatchEvent(
			new KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				...init,
			}),
		);
	key({ key: "Enter" });
	key({ key: "F10" });
	expect(asked).toEqual([]);
	key({ key: "ContextMenu" });
	key({ key: "F10", shiftKey: true });
	expect(asked.map((one) => one.via)).toEqual(["key", "key"]);
});

test("detaching takes every gesture away", () => {
	const { seat, asked, detach } = setup();
	detach();
	seat.dispatchEvent(
		new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
	);
	expect(asked).toEqual([]);
});
