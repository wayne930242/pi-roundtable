import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { PerspectiveCamera, Vector3 } from "three";
import {
	blendShot,
	closeupShot,
	DIVE_TURN_MS,
	dragAngle,
	EDGE_PX,
	easeDive,
	fitFov,
	fits,
	headCorners,
	MAX_SEATED,
	MAX_TURN_MS,
	MIN_TURN_MS,
	namePoints,
	normalizeAngle,
	overviewShot,
	planMove,
	podiumPlace,
	project,
	ringRadius,
	seatAhead,
	seatCorners,
	shortestArc,
	shotVectors,
	slotAngle,
	slotsFor,
	snapAngle,
	spacingFor,
	startsAtEdge,
	TAU,
	zoomIntent,
} from "./table/camera.ts";
import { hallOf } from "./table/hall.ts";
import { createLoop, type LoopHost } from "./table/loop.ts";
import { NAME_GAP, spreadNames } from "./table/name-layout.ts";
import {
	drawPlate,
	fitPlateText,
	PLATE_FONT_STACK,
	type PlateContext,
} from "./table/plate.ts";
import { badgeOf, STANDEE_TURN, standeeTurn } from "./table/podium3d.ts";
import { createSpeedLines } from "./table/speed.ts";
import { mixHex, ringOffsets } from "./table/standee.ts";
import { layoutOf } from "./table/table2d.ts";

beforeAll(() => GlobalRegistrator.register({ width: 1280, height: 800 }));
afterAll(() => GlobalRegistrator.unregister());

describe("the camera planner", () => {
	test("the owner's podium is the camera's home and the agents stand side by side across the ring from it", () => {
		const count = 6;
		expect(slotAngle(0, count)).toBe(0);
		const agents = Array.from({ length: count - 1 }, (_, i) =>
			slotAngle(i + 1, count),
		);
		const gaps = agents
			.slice(1)
			.map((angle, i) => shortestArc(agents[i] ?? 0, angle));
		for (const gap of gaps) expect(gap).toBeCloseTo(spacingFor(count), 9);
		// the row is centred on the far side, so the middle of it is straight across from the owner
		const middle =
			(agents[0] ?? 0) + shortestArc(agents[0] ?? 0, agents.at(-1) ?? 0) / 2;
		expect(Math.abs(normalizeAngle(middle - Math.PI))).toBeLessThan(1e-9);
		// a big table fills the ring evenly
		const many = 14;
		expect(spacingFor(many)).toBeCloseTo(TAU / many, 9);
		expect(slotAngle(many / 2, many)).toBeCloseTo(Math.PI, 9);
		const owner = podiumPlace(0, count);
		expect(owner.x).toBeCloseTo(0, 9);
		expect(owner.z).toBeCloseTo(ringRadius(count), 9);
		// a podium's front looks at the centre
		const place = podiumPlace(2, count);
		expect(Math.sin(place.yaw)).toBeCloseTo(-place.x / ringRadius(count), 9);
		expect(Math.cos(place.yaw)).toBeCloseTo(-place.z / ringRadius(count), 9);
		// neighbours stand at least 2.6 units apart
		const a = podiumPlace(2, count);
		const b = podiumPlace(3, count);
		expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(2.59);
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

	test("the dive into a seat creeps, then rushes in, in about 400 ms", () => {
		expect(easeDive(0)).toBeCloseTo(0, 9);
		expect(easeDive(1)).toBeCloseTo(1, 6);
		// slow at first: half the time covers a tenth of the way, and the last tenth of the time more than a quarter
		expect(easeDive(0.5)).toBeLessThan(0.1);
		expect(easeDive(1) - easeDive(0.9)).toBeGreaterThan(0.25);
		let last = 0;
		for (let t = 0.05; t <= 1; t += 0.05) {
			expect(easeDive(t)).toBeGreaterThanOrEqual(last);
			last = easeDive(t);
		}
		const dive = planMove(overviewShot(0, 6), closeupShot(1, 6), false, true);
		expect(dive).toEqual({ ms: DIVE_TURN_MS, cut: false, dive: true });
		expect(DIVE_TURN_MS).toBeGreaterThanOrEqual(300);
		expect(DIVE_TURN_MS).toBeLessThanOrEqual(450);
		// reduced motion still cuts
		expect(planMove(overviewShot(0, 6), closeupShot(1, 6), true, true)).toEqual(
			{
				ms: 0,
				cut: true,
			},
		);
	});

	test("letting go of a drag snaps to the nearest podium's place", () => {
		const count = 6;
		expect(snapAngle(0.2, count)).toBeCloseTo(0, 9);
		expect(snapAngle(slotAngle(1, count) + 0.1, count)).toBeCloseTo(
			slotAngle(1, count),
			9,
		);
		expect(snapAngle(Math.PI - 0.05, 4)).toBeCloseTo(slotAngle(2, 4), 9);
		// a drag of half the canvas' width is an eighth of the ring
		expect(Math.abs(dragAngle(300, 600))).toBeCloseTo(Math.PI / 4, 9);
	});

	test("the overview stands outside the ring on the owner's side, raised; a close-up stands inside, low, looking out at the podium", () => {
		const view = shotVectors(overviewShot(0, 6));
		expect(view.position[2]).toBeGreaterThan(ringRadius(6));
		expect(view.position[1]).toBeGreaterThan(4);
		// it looks across the ring, at the row of podiums opposite the owner's
		expect(view.target[0]).toBeCloseTo(0, 9);
		expect(view.target[2]).toBeLessThan(0);
		const az = slotAngle(2, 6);
		const near = closeupShot(az, 6);
		const { position, target } = shotVectors(near);
		expect(Math.hypot(position[0], position[2])).toBeLessThan(ringRadius(6));
		// low: the eye is below head height, looking a little down so the speaker rides above the dialogue box
		expect(position[1]).toBeLessThan(2.2);
		expect(target[1]).toBeGreaterThan(1);
		const podium = podiumPlace(2, 6);
		expect(Math.hypot(target[0] - podium.x, target[2] - podium.z)).toBeLessThan(
			0.6,
		);
		expect(near.roll).not.toBe(0);
	});

	test("the overview keeps every seat and plate in frame, with a margin, for two to ten agents on a wide and a tall picture", () => {
		// 1280×800, a phone's scene beside its box (390 × 55 % of 844), and a tall one
		for (const aspect of [1280 / 800, 390 / (844 * 0.55), 390 / 844]) {
			for (let agents = 1; agents <= MAX_SEATED + 1; agents += 1) {
				const count = slotsFor(agents).count;
				for (const az of [0, snapAngle(0.9, count), slotAngle(1, count)]) {
					const shot = overviewShot(az, count, aspect);
					// measured with three's own camera, not the planner's projection
					const camera = new PerspectiveCamera(
						fitFov(shot.fov, aspect),
						aspect,
						0.1,
						90,
					);
					const { position, target } = shotVectors(shot);
					camera.position.set(...position);
					camera.lookAt(target[0], target[1], target[2]);
					camera.updateMatrixWorld();
					camera.updateProjectionMatrix();
					for (const corner of seatCorners(count)) {
						const at = new Vector3(...corner).project(camera);
						expect(Math.abs(at.x)).toBeLessThan(1 - 0.05);
						expect(Math.abs(at.y)).toBeLessThan(1 - 0.05);
					}
					expect(fits(shot, aspect, seatCorners(count))).toBe(true);
				}
			}
		}
	});

	test("the overview keeps ten agents and their names inside the phone's real canvas, 366 by 390", () => {
		const width = 366;
		const height = 390;
		const aspect = width / height;
		const count = slotsFor(10).count;
		for (const az of [0, snapAngle(0.9, count), slotAngle(1, count)]) {
			const shot = overviewShot(az, count, aspect, width);
			const camera = new PerspectiveCamera(
				fitFov(shot.fov, aspect),
				aspect,
				0.1,
				90,
			);
			const { position, target } = shotVectors(shot);
			camera.position.set(...position);
			camera.lookAt(target[0], target[1], target[2]);
			camera.updateMatrixWorld();
			camera.updateProjectionMatrix();
			for (const corner of seatCorners(count)) {
				const at = new Vector3(...corner).project(camera);
				expect(Math.abs(at.x)).toBeLessThan(0.95);
				expect(Math.abs(at.y)).toBeLessThan(0.95);
			}
			// a name button is about 88 px wide and must not cross the canvas's sides
			for (const point of namePoints(count)) {
				const at = new Vector3(...point).project(camera);
				expect(Math.abs(at.x) * (width / 2) + 44).toBeLessThan(width / 2);
			}
		}
	});

	test("the overview pulls back for a crowded ring or a tall picture, and rests at its usual distance for a small table on a wide one", () => {
		const rest = (count: number) => ringRadius(count) + 4.4;
		expect(overviewShot(0, 3, 1.6).r).toBeCloseTo(rest(3), 9);
		expect(overviewShot(0, 11, 1.6).r).toBeGreaterThan(rest(11));
		expect(overviewShot(0, 4, 0.46).r).toBeGreaterThan(
			overviewShot(0, 4, 1.6).r,
		);
		// what it looks at does not move, and a point there lands in the middle of the picture
		const shot = overviewShot(0, 11, 0.46);
		const { target } = shotVectors(shot);
		const middle = project(shot, 0.46, target);
		expect(middle.x).toBeCloseTo(0, 6);
		expect(middle.y).toBeCloseTo(0, 6);
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

describe("the names over the podiums", () => {
	/** Where the names of ten agents land on the phone's 366 by 390 picture, as the page lays them over the plates. */
	const phoneNames = () => {
		const width = 366;
		const height = 390;
		const labels = [
			"Atlas",
			"Scout",
			"Archivist",
			"Mason",
			"Cook",
			"Nurse",
			"Pilot",
			"Smith",
			"Baker",
			"Clerk",
		];
		const shot = overviewShot(0, 11, width / height, width);
		return namePoints(11).map((point, i) => {
			const at = project(shot, width / height, point);
			return {
				x: (at.x * 0.5 + 0.5) * width,
				y: (-at.y * 0.5 + 0.5) * height,
				w: 21 + 5.6 * (labels[i]?.length ?? 5),
				h: 22,
			};
		});
	};
	const touching = (
		names: ReadonlyArray<{ x: number; y: number }>,
		sizes: ReadonlyArray<{ w: number; h: number }>,
	) => {
		let count = 0;
		for (let i = 0; i < names.length; i += 1)
			for (let j = i + 1; j < names.length; j += 1) {
				const a = names[i];
				const b = names[j];
				const sa = sizes[i];
				const sb = sizes[j];
				if (!a || !b || !sa || !sb) continue;
				if (
					Math.abs(a.x - b.x) < (sa.w + sb.w) / 2 &&
					Math.abs(a.y - b.y) < (sa.h + sb.h) / 2
				)
					count += 1;
			}
		return count;
	};

	test("ten agents' plates on the phone stand closer than their names are wide: laid over the plates the names overlap, and the layout steps them clear without leaving the picture", () => {
		const names = phoneNames();
		expect(touching(names, names)).toBeGreaterThan(0);
		const layout = spreadNames(names, { width: 366, height: 390 });
		expect(layout.clear).toBe(true);
		expect(touching(layout.spots, names)).toBe(0);
		layout.spots.forEach((spot, i) => {
			const name = names[i];
			if (!name) throw new Error("a name is missing");
			expect(spot.x - name.w / 2).toBeGreaterThanOrEqual(0);
			expect(spot.x + name.w / 2).toBeLessThanOrEqual(366);
			expect(spot.y - name.h / 2).toBeGreaterThanOrEqual(0);
			expect(spot.y + name.h / 2).toBeLessThanOrEqual(390);
			// a name stays in its own column and within a few rows of its plate
			expect(Math.abs(spot.y - name.y)).toBeLessThanOrEqual(
				4 * (name.h + NAME_GAP),
			);
		});
	});

	/**
	 * A whole table as the page lays it out: each plate's place on the screen, the box of every standee's head
	 * and face (from the camera's own projection), and the plates' sizes, for `count` slots (the owner's and the agents') in a picture `width` by `height`.
	 */
	const tableOf = (count: number, width: number, height: number) => {
		const aspect = width / height;
		const shot = overviewShot(0, count, aspect, width);
		const { position } = shotVectors(shot);
		const eye: [number, number, number] = [
			position[0],
			position[1],
			position[2],
		];
		const ring = ringRadius(count);
		const size = Math.max(12, Math.min(16, width * 0.0125));
		const labels = [
			"Atlas",
			"Scout",
			"Archivist",
			"Mason",
			"Cook",
			"Nurse",
			"Pilot",
			"Smith",
			"Baker",
			"Clerk",
		];
		const onScreen = (point: readonly [number, number, number]) => {
			const at = project(shot, aspect, point);
			return { x: (at.x * 0.5 + 0.5) * width, y: (-at.y * 0.5 + 0.5) * height };
		};
		const names: Array<{
			x: number;
			y: number;
			w: number;
			h: number;
			above: { x: number; y: number };
		}> = [];
		const faces: Array<{ x: number; y: number; w: number; h: number }> = [];
		for (let slot = 1; slot < count; slot += 1) {
			const az = slotAngle(slot, count);
			const x = Math.sin(az) * ring;
			const z = Math.cos(az) * ring;
			// the plate stands on whichever face of the podium looks toward the camera
			const inward = [-Math.sin(az), -Math.cos(az)];
			const side =
				(eye[0] - x) * (inward[0] ?? 0) + (eye[2] - z) * (inward[1] ?? 0) >= 0
					? 1
					: -1;
			const at = onScreen([
				x + side * 0.68 * (inward[0] ?? 0),
				1.26,
				z + side * 0.68 * (inward[1] ?? 0),
			]);
			const label = labels[(slot - 1) % labels.length] ?? "Atlas";
			const corners = headCorners([x, 0.2 + 1.3 + 1.45, z], 1, eye).map(
				onScreen,
			);
			const xs = corners.map((c) => c.x);
			const ys = corners.map((c) => c.y);
			const face = {
				x: (Math.min(...xs) + Math.max(...xs)) / 2,
				y: (Math.min(...ys) + Math.max(...ys)) / 2,
				w: Math.max(...xs) - Math.min(...xs),
				h: Math.max(...ys) - Math.min(...ys),
			};
			faces.push(face);
			const h = size * 1.53 + 4;
			names.push({
				...at,
				w: ((21 + 5.6 * label.length) * size) / 12,
				h,
				// the place over its own head, as the page offers each name
				above: { x: face.x, y: face.y - face.h / 2 - h / 2 - NAME_GAP },
			});
		}
		return { names, faces, width, height };
	};
	const covers = (
		names: ReadonlyArray<{ x: number; y: number }>,
		sizes: ReadonlyArray<{ w: number; h: number }>,
		faces: ReadonlyArray<{ x: number; y: number; w: number; h: number }>,
	) =>
		names.flatMap((name, i) => {
			const size = sizes[i];
			if (!size) return [];
			return faces
				.map((face, f) => ({ i, f, face }))
				.filter(
					({ face }) =>
						Math.abs(name.x - face.x) < (size.w + face.w) / 2 &&
						Math.abs(name.y - face.y) < (size.h + face.h) / 2,
				);
		});

	test("laid over their plates, a rear podium's name lands on the standee in front of it; with the faces known no name covers any face, nor another name, nor leaves the picture, from two to ten agents on the phone and the desktop", () => {
		const phone = tableOf(11, 366, 390);
		expect(
			covers(phone.names, phone.names, phone.faces).length,
		).toBeGreaterThan(0);
		for (const [width, height] of [
			[366, 390],
			[992, 712],
			[600, 700],
			// a phone's picture fills the page's height, a narrow one is a small phone's
			[366, 650],
			[296, 520],
		] as const)
			for (let count = 3; count <= 11; count += 1) {
				const table = tableOf(count, width, height);
				const layout = spreadNames(table.names, { width, height }, table.faces);
				const where = `${count} slots at ${width}x${height}`;
				expect(layout.clear, where).toBe(true);
				expect(layout.covering, where).toBe(0);
				expect(covers(layout.spots, table.names, table.faces), where).toEqual(
					[],
				);
				expect(touching(layout.spots, table.names), where).toBe(0);
				layout.spots.forEach((spot, i) => {
					const name = table.names[i];
					if (!name) throw new Error("a name is missing");
					expect(spot.x - name.w / 2, where).toBeGreaterThanOrEqual(0);
					expect(spot.x + name.w / 2, where).toBeLessThanOrEqual(width);
					expect(spot.y - name.h / 2, where).toBeGreaterThanOrEqual(0);
					expect(spot.y + name.h / 2, where).toBeLessThanOrEqual(height);
				});
			}
	});

	test("a name whose plate lies on a face goes to the nearest free place, and over its own standee's head when that is nearly as close", () => {
		const bounds = { width: 366, height: 390 };
		const face = { x: 100, y: 200, w: 60, h: 40 };
		const on = { x: 100, y: 200, w: 50, h: 22 };
		// without an own head to go to, it steps off the face by the shortest way
		const plain = spreadNames([on], bounds, [face]);
		expect(plain.covering).toBe(0);
		expect(plain.spots[0]?.y).not.toBe(200);
		// with one, it stands just over the head, as a name tag
		const above = { x: 100, y: 200 - 20 - 11 - NAME_GAP };
		const tagged = spreadNames([{ ...on, above }], bounds, [face]);
		expect(tagged.spots[0]).toEqual(above);
		// a name on a clear plate stays on it whatever its head offers
		const apart = spreadNames(
			[{ x: 300, y: 300, w: 50, h: 22, above: { x: 300, y: 250 } }],
			bounds,
			[face],
		);
		expect(apart.spots[0]).toEqual({ x: 300, y: 300 });
	});

	test("a plate is as tall as its lettering: the stylesheet gives it no button's minimum height, which the layout above counts on", () => {
		const css = readFileSync(
			join(import.meta.dir, "styles", "table.css"),
			"utf8",
		);
		const rule = /\.rt-name \{([^}]*)\}/.exec(css)?.[1] ?? "";
		expect(rule).toMatch(/min-height:\s*0\s*;/);
	});

	test("names that already stand clear stay on their plates, and the nearest name keeps its place when two collide", () => {
		const apart = [
			{ x: 100, y: 200, w: 80, h: 22 },
			{ x: 250, y: 204, w: 80, h: 22 },
			{ x: 110, y: 260, w: 80, h: 22 },
		];
		const same = spreadNames(apart, { width: 366, height: 390 });
		expect(same.clear).toBe(true);
		expect(same.spots).toEqual(apart.map(({ x, y }) => ({ x, y })));
		const pair = spreadNames(
			[
				{ x: 150, y: 150, w: 80, h: 22 },
				{ x: 170, y: 200, w: 80, h: 22 },
				{ x: 160, y: 210, w: 80, h: 22 },
			],
			{ width: 366, height: 390 },
		);
		// the lowest (nearest) stays; the others make way a row at a time, each clear of the rest
		expect(pair.spots[2]).toEqual({ x: 160, y: 210 });
		expect(pair.spots[1]?.y).not.toBe(200);
		expect(pair.clear).toBe(true);
		expect(spreadNames([], { width: 366, height: 390 }).clear).toBe(true);
	});

	test("a name past the picture's side is brought in, and a pile too big for the picture is reported as not clear", () => {
		const edge = spreadNames([{ x: 5, y: 100, w: 80, h: 22 }], {
			width: 366,
			height: 390,
		});
		expect(edge.spots[0]?.x).toBeGreaterThanOrEqual(40);
		const pile = Array.from({ length: 80 }, () => ({
			x: 100,
			y: 100,
			w: 80,
			h: 22,
		}));
		expect(spreadNames(pile, { width: 366, height: 390 }).clear).toBe(false);
	});
});

describe("the standee's turn", () => {
	/** How far a standee's face is from the camera, in radians, whichever side of the podium the camera is on. */
	const off = (x: number, z: number) => {
		const turn = standeeTurn(x, z);
		const toCamera = Math.atan2(x, z);
		return Math.abs(normalizeAngle(turn - toCamera));
	};

	test("a camera in front of the podium turns the board toward it, by no more than the limit", () => {
		expect(standeeTurn(0, 5)).toBeCloseTo(0, 9);
		expect(standeeTurn(1, 5)).toBeCloseTo(Math.atan2(1, 5), 9);
		expect(standeeTurn(9, 3)).toBeCloseTo(STANDEE_TURN, 9);
		expect(standeeTurn(-9, 3)).toBeCloseTo(-STANDEE_TURN, 9);
	});

	test("a camera behind the podium (the seats nearest the owner's, seen from outside the ring) gets the board's face, never its back", () => {
		// the seat at the owner's side of the ring: the camera stands behind it and a little to one side
		expect(
			Math.cos(standeeTurn(2.5, -11) - Math.atan2(2.5, -11)),
		).toBeGreaterThan(0.8);
		expect(
			Math.cos(standeeTurn(-2.5, -11) - Math.atan2(-2.5, -11)),
		).toBeGreaterThan(0.8);
		// at any angle round the podium the board's face is toward the camera
		for (let step = 0; step < 72; step += 1) {
			const angle = (step / 72) * TAU;
			const x = Math.sin(angle) * 10;
			const z = Math.cos(angle) * 10;
			expect(off(x, z)).toBeLessThan(Math.PI / 2);
			expect(off(x, z)).toBeLessThanOrEqual(Math.PI / 2 - 0.5);
		}
	});
});

describe("the standee board", () => {
	test("its edge is drawn all the way round the figure, and the board's own colour is the accent moved toward the ink", () => {
		const offsets = ringOffsets(10, 24);
		expect(offsets).toHaveLength(24);
		for (const [dx, dy] of offsets)
			expect(Math.hypot(dx, dy)).toBeCloseTo(10, 9);
		expect(mixHex("#ffffff", "#000000", 0.5)).toBe("#808080");
		expect(mixHex("#c0392b", "#0b0f1e", 0)).toBe("#c0392b");
		expect(mixHex("#c0392b", "#0b0f1e", 1)).toBe("#0b0f1e");
	});
});

describe("the 2D hall", () => {
	test("up to six podiums stand in one row, more in two rows, and the strip is always one", () => {
		expect(layoutOf(3, false)).toEqual({ rows: 1, perRow: 3 });
		expect(layoutOf(6, false)).toEqual({ rows: 1, perRow: 6 });
		expect(layoutOf(7, false)).toEqual({ rows: 2, perRow: 4 });
		expect(layoutOf(12, false)).toEqual({ rows: 2, perRow: 6 });
		expect(layoutOf(12, true)).toEqual({ rows: 1, perRow: 12 });
		expect(layoutOf(0, false)).toEqual({ rows: 1, perRow: 1 });
	});
});
