import { describe, expect, test } from "bun:test";
import { normalizeAngle, TAU } from "./table/camera.ts";
import { hallOf } from "./table/hall.ts";
import {
	Podium,
	PodiumKit,
	STANDEE_TURN,
	standeeTurn,
} from "./table/podium3d.ts";
import { mixHex, ringOffsets } from "./table/standee.ts";
import { layoutOf } from "./table/table2d.ts";
import { mouthOpenAt, TALK_HZ, talkFrames } from "./table/talk.ts";
import { Toon } from "./table/toon.ts";
import { sceneHall } from "./table-scene-fixture.ts";

sceneHall();

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

describe("the talking mouth", () => {
	test("it opens and closes about seven times a second, a beat now and then held shut, out of step between speakers", () => {
		const samples = (phase: number) =>
			Array.from({ length: 140 }, (_, at) => mouthOpenAt(at / 70, phase));
		const opens = (list: boolean[]) =>
			list.filter((open, at) => open && !list[at - 1]).length;
		const one = samples(0);
		// two seconds: about fourteen openings, a few held shut
		expect(opens(one)).toBeGreaterThanOrEqual(8);
		expect(opens(one)).toBeLessThanOrEqual(2 * TALK_HZ);
		expect(one.filter(Boolean).length).toBeGreaterThan(30);
		expect(samples(1.3)).not.toEqual(one);
		const { frames, seconds } = talkFrames(2);
		expect(frames.every((frame) => frame === 0 || frame === 1)).toBe(true);
		expect(frames).toContain(1);
		expect(seconds).toBeCloseTo(frames.length / (TALK_HZ * 2), 9);
	});

	test("the 3D standee swaps its board between the closed and the open picture, and only while it has an open one", () => {
		// happy-dom draws nothing: a 2D context that takes every call and answers with a number does for the podium's canvases.
		const anything: unknown = new Proxy(() => undefined, {
			get: (_, key) => (key === Symbol.toPrimitive ? () => 10 : anything),
			apply: () => anything,
			set: () => true,
		});
		const real = HTMLCanvasElement.prototype.getContext;
		HTMLCanvasElement.prototype.getContext = (() =>
			anything) as typeof HTMLCanvasElement.prototype.getContext;
		try {
			const kit = new PodiumKit(hallOf("camelot", "dark"));
			const podium = new Podium(
				{ id: "gawain", name: "Gawain", kind: "agent", accent: "#a5435f" },
				kit,
				new Toon(),
			);
			const picture = () => document.createElement("canvas");
			podium.setSticker(picture());
			const closed = podium.boardMaterial.map;
			// no open frame yet: the mouth stays as drawn
			expect(podium.mouth(true)).toBe(false);
			expect(podium.boardMaterial.map).toBe(closed);
			podium.setTalk(picture());
			expect(podium.mouth(true)).toBe(true);
			const open = podium.boardMaterial.map;
			expect(open).not.toBe(closed);
			expect(podium.mouth(false)).toBe(true);
			expect(podium.boardMaterial.map).toBe(closed);
			// it opens again, then the open frame goes: the board shows the closed one
			podium.mouth(true);
			podium.setTalk(undefined);
			expect(podium.boardMaterial.map).toBe(closed);
			expect(podium.mouth(true)).toBe(false);
			podium.dispose();
			kit.dispose();
		} finally {
			HTMLCanvasElement.prototype.getContext = real;
		}
	});
});
