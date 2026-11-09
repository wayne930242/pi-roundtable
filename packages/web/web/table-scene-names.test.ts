import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	headCorners,
	namePoints,
	overviewShot,
	project,
	ringRadius,
	shotVectors,
	slotAngle,
} from "./table/camera.ts";
import { NAME_GAP, spreadNames } from "./table/name-layout.ts";
import { sceneHall } from "./table-scene-fixture.ts";

sceneHall();

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

	test("a phone typing in the dialogue box keeps the message box over the keyboard: the box sizes to what it holds, the scene yields down to a sliver, and the message box scrolls inside past a share of the visible height", () => {
		// One space for every run of whitespace: the formatter breaks a long selector over lines.
		const css = readFileSync(
			join(import.meta.dir, "styles", "table.css"),
			"utf8",
		).replace(/\s+/g, " ");
		const typing =
			".table-frame[data-focused]:has(.scene-composer:focus-within)";
		const ruleOf = (selector: string) => {
			const start = css.indexOf(`${selector} {`);
			expect(start).toBeGreaterThan(-1);
			return css.slice(start, css.indexOf("}", start));
		};
		// Not under a portrait query: the keyboard can leave the visible area wider than tall.
		const media = css.lastIndexOf("@media", css.indexOf(typing));
		expect(css.slice(media, css.indexOf("{", media))).toBe(
			"@media (max-width: 719px) ",
		);
		expect(ruleOf(typing)).toMatch(/display:\s*flex;/);
		expect(ruleOf(`${typing} .table-host`)).toMatch(/min-height:\s*15%;/);
		const box = ruleOf(`${typing} .scene-box`);
		expect(box).toMatch(/flex:\s*0 1 auto;/);
		expect(box).toMatch(/max-height:\s*none;/);
		expect(ruleOf(`${typing} .scene-composer textarea`)).toMatch(
			/max-height:\s*max\(5\.5rem, calc\(var\(--app-height, 100dvh\) \* 0\.3\)\);/,
		);
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
