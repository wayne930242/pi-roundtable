import { describe, expect, test } from "bun:test";
import { AlertThrottle } from "./alert-throttle.ts";

const WINDOW = 1000;

function setup(groupCap = 2) {
	let now = 5000;
	const throttle = new AlertThrottle({
		windowMs: WINDOW,
		groupCap,
		now: () => now,
	});
	return {
		throttle,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

/** What the callers do once a key is open. */
function take(throttle: AlertThrottle, key: string, group: string) {
	throttle.hold(key);
	throttle.slot(group);
}

describe("AlertThrottle", () => {
	test("a held key repeats until exactly one window has passed", () => {
		const { throttle, advance } = setup();
		expect(throttle.admit("a", "g")).toBe("open");
		throttle.hold("a");
		expect(throttle.admit("a", "g")).toBe("repeat");
		advance(WINDOW - 1);
		expect(throttle.admit("a", "g")).toBe("repeat");
		advance(1);
		expect(throttle.admit("a", "g")).toBe("open");
	});

	test("admit alone holds nothing", () => {
		const { throttle } = setup();
		expect(throttle.admit("a", "g")).toBe("open");
		expect(throttle.admit("a", "g")).toBe("open");
	});

	test("a group is full at its cap, and only for its own keys", () => {
		const { throttle } = setup();
		take(throttle, "a", "g");
		take(throttle, "b", "g");
		expect(throttle.admit("c", "g")).toBe("full");
		expect(throttle.admit("c", "other")).toBe("open");
		expect(throttle.admit("a", "g")).toBe("repeat");
	});

	test("uncapped ignores a full group but not a held key", () => {
		const { throttle } = setup(1);
		take(throttle, "a", "g");
		expect(throttle.admit("b", "g", true)).toBe("open");
		expect(throttle.admit("a", "g", true)).toBe("repeat");
	});

	test("a slot leaves the group when its window is over", () => {
		const { throttle, advance } = setup();
		take(throttle, "a", "g");
		advance(400);
		take(throttle, "b", "g");
		advance(599);
		expect(throttle.admit("c", "g")).toBe("full");
		advance(1);
		expect(throttle.admit("c", "g")).toBe("open");
	});

	test("release gives back the key and the newest slot", () => {
		const { throttle } = setup();
		take(throttle, "a", "g");
		take(throttle, "b", "g");
		throttle.release("b", "g");
		expect(throttle.admit("b", "g")).toBe("open");
		expect(throttle.admit("a", "g")).toBe("repeat");
		take(throttle, "b", "g");
		expect(throttle.admit("c", "g")).toBe("full");
	});

	test("release without a group gives back the key only", () => {
		const { throttle } = setup(1);
		take(throttle, "a", "g");
		throttle.release("a");
		expect(throttle.admit("a", "g")).toBe("full");
	});

	test("roomAt is the oldest slot's end while the group is full, else undefined", () => {
		const { throttle, advance } = setup();
		expect(throttle.roomAt("g")).toBeUndefined();
		take(throttle, "a", "g");
		advance(100);
		take(throttle, "b", "g");
		expect(throttle.roomAt("g")).toBe(5000 + WINDOW);
		advance(WINDOW - 100);
		expect(throttle.roomAt("g")).toBeUndefined();
	});
});
