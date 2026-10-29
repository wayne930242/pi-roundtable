import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	blendShot,
	closeupShot,
	dragAngle,
	EDGE_PX,
	fitFov,
	MAX_SEATED,
	MAX_TURN_MS,
	MIN_TURN_MS,
	normalizeAngle,
	overviewShot,
	planMove,
	podiumPlace,
	ringRadius,
	seatAhead,
	shortestArc,
	shotVectors,
	slotAngle,
	slotsFor,
	snapAngle,
	startsAtEdge,
	TAU,
	zoomIntent,
} from "./table/camera.ts";
import { hallOf } from "./table/hall.ts";
import { createLoop, type LoopHost } from "./table/loop.ts";
import {
	drawPlate,
	fitPlateText,
	PLATE_FONT_STACK,
	type PlateContext,
} from "./table/plate.ts";
import { badgeOf, STANDEE_TURN } from "./table/podium3d.ts";
import { createSpeedLines } from "./table/speed.ts";

beforeAll(() => GlobalRegistrator.register({ width: 1280, height: 800 }));
afterAll(() => GlobalRegistrator.unregister());

describe("the camera planner", () => {
	test("podiums stand evenly round the ring, the owner's at the camera's home", () => {
		const count = 5;
		expect(slotAngle(0, count)).toBe(0);
		const angles = Array.from({ length: count }, (_, slot) =>
			slotAngle(slot, count),
		);
		const gaps = angles.map((angle, i) =>
			shortestArc(angle, angles[(i + 1) % count] ?? 0),
		);
		for (const gap of gaps) expect(gap).toBeCloseTo(TAU / count, 9);
		const owner = podiumPlace(0, count);
		expect(owner.x).toBeCloseTo(0, 9);
		expect(owner.z).toBeCloseTo(ringRadius(count), 9);
		// a podium's front looks at the centre
		const place = podiumPlace(2, count);
		expect(Math.sin(place.yaw)).toBeCloseTo(-place.x / ringRadius(count), 9);
		expect(Math.cos(place.yaw)).toBeCloseTo(-place.z / ringRadius(count), 9);
	});

	test("a turn takes the shorter way round the ring, whichever side the target is on", () => {
		expect(shortestArc(0.2, 0.5)).toBeCloseTo(0.3, 9);
		expect(shortestArc(3, -3)).toBeCloseTo(TAU - 6, 9);
		expect(shortestArc(-3, 3)).toBeCloseTo(6 - TAU, 9);
		expect(Math.abs(shortestArc(0, Math.PI))).toBeCloseTo(Math.PI, 9);
		expect(normalizeAngle(TAU + 0.1)).toBeCloseTo(0.1, 9);
		const from = closeupShot(3, 7);
		const to = closeupShot(-3, 7);
		const half = blendShot(from, to, 0.5);
		// 3 and -3 are 0.28 rad apart across the back of the ring: halfway is near π, not near 0
		expect(Math.abs(half.az)).toBeGreaterThan(2.5);
	});

	test("a move takes 450 ms for a step and 650 ms for half the ring, and a cut under reduced motion", () => {
		const step = planMove(closeupShot(0, 7), closeupShot(0.0001, 7), false);
		expect(step.ms).toBeCloseTo(MIN_TURN_MS, -1);
		const far = planMove(closeupShot(0, 7), closeupShot(Math.PI, 7), false);
		expect(far.ms).toBeLessThanOrEqual(MAX_TURN_MS);
		expect(far.ms).toBeGreaterThan(MAX_TURN_MS - 5);
		expect(far.cut).toBe(false);
		const cut = planMove(closeupShot(0, 7), closeupShot(Math.PI, 7), true);
		expect(cut).toEqual({ ms: 0, cut: true });
	});

	test("letting go of a drag snaps to the nearest podium's place", () => {
		const count = 6;
		expect(snapAngle(0.2, count)).toBeCloseTo(0, 9);
		expect(snapAngle(slotAngle(1, count) + 0.1, count)).toBeCloseTo(
			slotAngle(1, count),
			9,
		);
		expect(snapAngle(Math.PI - 0.05, 4)).toBeCloseTo(Math.PI, 9);
		// a drag of half the canvas' width is an eighth of the ring
		expect(Math.abs(dragAngle(300, 600))).toBeCloseTo(Math.PI / 4, 9);
	});

	test("the overview stands outside the ring on the owner's side, raised; a close-up stands inside, low, looking out at the podium", () => {
		const view = shotVectors(overviewShot(0, 6));
		expect(view.position[2]).toBeGreaterThan(ringRadius(6));
		expect(view.position[1]).toBeGreaterThan(4);
		expect(view.target[0]).toBeCloseTo(0, 9);
		expect(view.target[2]).toBeCloseTo(0, 9);
		const az = slotAngle(2, 6);
		const near = closeupShot(az, 6);
		const { position, target } = shotVectors(near);
		expect(Math.hypot(position[0], position[2])).toBeLessThan(ringRadius(6));
		expect(position[1]).toBeLessThan(target[1]);
		const podium = podiumPlace(2, 6);
		expect(Math.hypot(target[0] - podium.x, target[2] - podium.z)).toBeLessThan(
			0.6,
		);
		expect(near.roll).not.toBe(0);
	});

	test("the ring seats twelve and a +N podium stands for the rest", () => {
		expect(slotsFor(3)).toEqual({ count: 4, seated: 3, more: 0 });
		expect(slotsFor(MAX_SEATED)).toEqual({
			count: 1 + MAX_SEATED,
			seated: MAX_SEATED,
			more: 0,
		});
		expect(slotsFor(15)).toEqual({
			count: 2 + MAX_SEATED,
			seated: MAX_SEATED,
			more: 3,
		});
	});

	test("a wheel turn or a pinch zooms in on the podium across, and back out to the ring", () => {
		expect(zoomIntent(-100, false)).toBe("in");
		expect(zoomIntent(100, true)).toBe("out");
		expect(zoomIntent(100, false)).toBe("none");
		expect(zoomIntent(-100, true)).toBe("none");
		const slots = slotsFor(5);
		// from the owner's podium the podium across is the one opposite slot 0
		const ahead = seatAhead(0, slots);
		expect(ahead).toBeDefined();
		const arc = Math.abs(
			shortestArc(Math.PI, slotAngle(ahead ?? 0, slots.count)),
		);
		expect(arc).toBeLessThan(TAU / slots.count / 2 + 1e-9);
		expect(seatAhead(0, slotsFor(0))).toBeUndefined();
	});

	test("a swipe never starts within 32 px of the screen's edge", () => {
		const box = { left: 0, top: 0, width: 390, height: 460 };
		const screen = { width: 390, height: 844 };
		expect(startsAtEdge(10, 200, box, screen)).toBe(true);
		expect(startsAtEdge(390 - EDGE_PX + 1, 200, box, screen)).toBe(true);
		expect(startsAtEdge(EDGE_PX + 1, 200, box, screen)).toBe(false);
		expect(startsAtEdge(200, 200, box, screen)).toBe(false);
		expect(startsAtEdge(200, 5, box, screen)).toBe(true);
	});

	test("a narrow view widens the field so the ring stays in frame", () => {
		expect(fitFov(42, 1.6)).toBe(42);
		expect(fitFov(42, 0.46)).toBeGreaterThan(42);
		expect(fitFov(90, 0.2)).toBeLessThanOrEqual(95);
	});
});

describe("the render loop", () => {
	const fakeHost = () => {
		let hidden = false;
		const queue = new Map<number, (now: number) => void>();
		let next = 1;
		const host: LoopHost = {
			request(run) {
				const id = next++;
				queue.set(id, run);
				return id;
			},
			cancel(id) {
				queue.delete(id);
			},
			hidden: () => hidden,
		};
		return {
			host,
			queue,
			hide: (value: boolean) => {
				hidden = value;
			},
			run(now: number) {
				const jobs = [...queue.entries()];
				queue.clear();
				for (const [, job] of jobs) job(now);
			},
		};
	};

	test("nothing is scheduled while the page is hidden, and the loop starts again when it shows", () => {
		const fake = fakeHost();
		let drawn = 0;
		const loop = createLoop({
			host: fake.host,
			frame: () => {
				drawn += 1;
				return false;
			},
		});
		loop.wake();
		fake.run(100);
		expect(drawn).toBe(1);
		fake.hide(true);
		loop.sync();
		expect(fake.queue.size).toBe(0);
		expect(loop.state).toBe("paused");
		fake.run(500);
		expect(drawn).toBe(1);
		fake.hide(false);
		loop.sync();
		expect(fake.queue.size).toBe(1);
		fake.run(900);
		expect(drawn).toBe(2);
		loop.dispose();
	});

	test("a scene that is off screen is paused, and one that moves draws every frame while a still one is throttled", () => {
		const fake = fakeHost();
		let moving = true;
		let drawn = 0;
		const loop = createLoop({
			host: fake.host,
			idleMs: 100,
			frame: () => {
				drawn += 1;
				return moving;
			},
		});
		loop.wake();
		fake.run(10);
		fake.run(26);
		fake.run(42);
		expect(drawn).toBe(3);
		expect(loop.state).toBe("live");
		moving = false;
		fake.run(58);
		expect(loop.state).toBe("idle");
		fake.run(74);
		fake.run(90);
		expect(drawn).toBe(4);
		fake.run(170);
		expect(drawn).toBe(5);
		loop.setVisible(false);
		expect(loop.state).toBe("paused");
		expect(fake.queue.size).toBe(0);
		loop.setVisible(true);
		expect(fake.queue.size).toBe(1);
		loop.dispose();
		expect(fake.queue.size).toBe(0);
	});

	test("with no idle gap (reduced motion) a still scene draws nothing until something wakes it", () => {
		const fake = fakeHost();
		let drawn = 0;
		const loop = createLoop({
			host: fake.host,
			idleMs: () => 0,
			frame: () => {
				drawn += 1;
				return false;
			},
		});
		loop.wake();
		fake.run(10);
		expect(drawn).toBe(1);
		expect(fake.queue.size).toBe(0);
		loop.wake();
		expect(fake.queue.size).toBe(1);
		loop.dispose();
	});
});

/** A canvas context that records what it was asked to draw, with the width a text takes by its glyphs. */
const recorder = () => {
	const calls: string[] = [];
	const g: PlateContext = {
		font: "",
		fillStyle: "",
		strokeStyle: "",
		lineWidth: 1,
		textAlign: "left",
		textBaseline: "alphabetic",
		measureText(text: string) {
			const px = Number(/(\d+)px/.exec(g.font)?.[1] ?? 10);
			let em = 0;
			for (const char of text)
				em += (char.codePointAt(0) ?? 0) >= 0x2e80 ? 1 : 0.6;
			return { width: em * px };
		},
		fillText(text: string) {
			calls.push(`${g.font}|${text}`);
		},
		fillRect() {},
		beginPath() {},
		moveTo() {},
		lineTo() {},
		closePath() {},
		arc() {},
		fill() {},
		stroke() {},
	};
	return { g, calls };
};

describe("the nameplate lettering", () => {
	const hall = hallOf("modern", "dark");

	test("a zh-TW name is drawn whole through a font stack that carries Chinese", () => {
		const { g, calls } = recorder();
		const text = drawPlate(g, "圓桌騎士", 512, 128, hall);
		expect(text.text).toBe("圓桌騎士");
		expect(calls).toHaveLength(1);
		const [font, drawn] = (calls[0] ?? "").split("|");
		expect(drawn).toBe("圓桌騎士");
		for (const face of ["PingFang TC", "Noto Sans TC", "Microsoft JhengHei"])
			expect(font).toContain(face);
		expect(PLATE_FONT_STACK.startsWith("system-ui")).toBe(true);
		expect(PLATE_FONT_STACK.endsWith("sans-serif")).toBe(true);
	});

	test("a long name shrinks to fit, then is cut with an ellipsis, never past the plate", () => {
		const { g } = recorder();
		const room = 512 * 0.86;
		const shrunk = fitPlateText(g, "亞瑟王的圓桌騎士", 512, 128);
		expect(shrunk.text).toBe("亞瑟王的圓桌騎士");
		expect(shrunk.px).toBeLessThan(128 * 0.56);
		const cut = fitPlateText(
			g,
			"亞瑟王與他的圓桌騎士團的第一位騎士蘭斯洛特",
			512,
			128,
		);
		expect(cut.text.endsWith("…")).toBe(true);
		g.font = cut.font;
		expect(g.measureText(cut.text).width).toBeLessThanOrEqual(room);
		const latin = fitPlateText(g, "Lancelot", 512, 128);
		expect(latin.text).toBe("Lancelot");
	});
});

describe("the hall's palettes", () => {
	test("dark is the night hall and light the same hall by day; the look moves only the accents", () => {
		const night = hallOf("modern", "dark");
		const day = hallOf("modern", "light");
		expect(night.night).toBe(true);
		expect(day.night).toBe(false);
		expect(night.stone).not.toBe(day.stone);
		const camelot = hallOf("camelot", "dark");
		expect(camelot.banner).not.toBe(night.banner);
		expect(camelot.stone).toBe(night.stone);
		expect(camelot.floor).toBe(night.floor);
	});
});

describe("the standee and its signs", () => {
	test("a thinking seat shows the waiting dots, a waiting one a bang, and a speaking or idle one nothing", () => {
		expect(badgeOf("thinking")).toBe("waiting");
		expect(badgeOf("working")).toBe("waiting");
		expect(badgeOf("waiting")).toBe("alert");
		expect(badgeOf("done")).toBe("done");
		expect(badgeOf("error")).toBe("error");
		expect(badgeOf("speaking")).toBeNull();
		expect(badgeOf("idle")).toBeNull();
	});

	test("a standee turns to the camera by no more than a third of a half turn", () => {
		expect(STANDEE_TURN).toBeLessThan(Math.PI / 4);
	});
});

describe("the speed lines", () => {
	test("they play once on a new speaker, and never under reduced motion", () => {
		const host = document.createElement("div");
		let reduced = false;
		const lines = createSpeedLines(host, () => reduced);
		expect(host.querySelector(".rt-speed")).not.toBeNull();
		expect(lines.play()).toBe(true);
		reduced = true;
		expect(lines.play()).toBe(false);
		lines.dispose();
		expect(host.querySelector(".rt-speed")).toBeNull();
	});
});
