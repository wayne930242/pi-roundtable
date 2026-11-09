import { describe, expect, test } from "bun:test";
import { hallOf } from "./table/hall.ts";
import { createLoop, type LoopHost } from "./table/loop.ts";
import { drawPlate, fitPlateText, PLATE_FONT_STACK } from "./table/plate.ts";
import { badgeOf, STANDEE_TURN } from "./table/podium3d.ts";
import { createSpeedLines } from "./table/speed.ts";
import { recorder, sceneHall } from "./table-scene-fixture.ts";

sceneHall();

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

describe("the nameplate lettering", () => {
	const hall = hallOf("modern", "dark");

	test("a zh-TW name is drawn whole through a font stack that carries Chinese", () => {
		const { g, calls } = recorder();
		const text = drawPlate(g, "\u5713\u684c\u9a0e\u58eb", 512, 128, hall);
		expect(text.text).toBe("\u5713\u684c\u9a0e\u58eb");
		expect(calls).toHaveLength(1);
		const [font, drawn] = (calls[0] ?? "").split("|");
		expect(drawn).toBe("\u5713\u684c\u9a0e\u58eb");
		for (const face of ["PingFang TC", "Noto Sans TC", "Microsoft JhengHei"])
			expect(font).toContain(face);
		expect(PLATE_FONT_STACK.startsWith("system-ui")).toBe(true);
		expect(PLATE_FONT_STACK.endsWith("sans-serif")).toBe(true);
	});

	test("a long name shrinks to fit, then is cut with an ellipsis, never past the plate", () => {
		const { g } = recorder();
		const room = 512 * 0.86;
		const shrunk = fitPlateText(
			g,
			"\u4e9e\u745f\u738b\u7684\u5713\u684c\u9a0e\u58eb",
			512,
			128,
		);
		expect(shrunk.text).toBe(
			"\u4e9e\u745f\u738b\u7684\u5713\u684c\u9a0e\u58eb",
		);
		expect(shrunk.px).toBeLessThan(128 * 0.56);
		const cut = fitPlateText(
			g,
			"\u4e9e\u745f\u738b\u8207\u4ed6\u7684\u5713\u684c\u9a0e\u58eb\u5718\u7684\u7b2c\u4e00\u4f4d\u9a0e\u58eb\u862d\u65af\u6d1b\u7279",
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
