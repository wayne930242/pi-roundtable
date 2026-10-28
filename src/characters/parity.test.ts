import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCanvas, loadImage } from "canvas";
import {
	CLASS_IDS,
	type ClassId,
	composeSvg,
	EXPRESSIONS,
	resolveCharacter,
} from "./index.ts";

// The lab's flat SVGs are what the boss approved; the port must draw the same picture.
const FIXTURES = resolve(import.meta.dir, "fixtures/lab");
const SIZE = 128;
const MAX_MEAN_DIFFERENCE = 1.5;
const MAX_FAR_SHARE = 0.005;
const FAR = 64;

/** The lab's class keys that ship under their labels. */
const LAB_KEY: Partial<Record<ClassId, string>> = {
	smith: "artisan",
	healer: "cleric",
	innkeeper: "chef",
};

async function raster(svg: string): Promise<Uint8ClampedArray> {
	const sized = svg.replace("<svg ", `<svg width="${SIZE}" height="${SIZE}" `);
	const image = await loadImage(Buffer.from(sized));
	const canvas = createCanvas(SIZE, SIZE);
	const context = canvas.getContext("2d");
	context.drawImage(image, 0, 0, SIZE, SIZE);
	return context.getImageData(0, 0, SIZE, SIZE).data;
}

async function compare(fixture: string, port: string) {
	const lab = await raster(readFileSync(resolve(FIXTURES, fixture), "utf8"));
	const ours = await raster(port);
	let total = 0;
	let far = 0;
	let drawn = 0;
	for (let at = 0; at < lab.length; at += 4) {
		let worst = 0;
		for (let channel = 0; channel < 4; channel++) {
			const difference = Math.abs(
				(lab[at + channel] ?? 0) - (ours[at + channel] ?? 0),
			);
			total += difference;
			worst = Math.max(worst, difference);
		}
		if (worst > FAR) far++;
		if ((lab[at + 3] ?? 0) > 0) drawn++;
	}
	const pixels = lab.length / 4;
	return {
		mean: total / lab.length,
		far: far / pixels,
		drawn: drawn / pixels,
	};
}

const STILL = { still: true, uid: "p" } as const;

function expectParity(result: Awaited<ReturnType<typeof compare>>): void {
	// A blank fixture would make any picture agree.
	expect(result.drawn).toBeGreaterThan(0.25);
	expect(result.mean).toBeLessThanOrEqual(MAX_MEAN_DIFFERENCE);
	expect(result.far).toBeLessThanOrEqual(MAX_FAR_SHARE);
}

test("every class draws what the lab drew", async () => {
	for (const id of CLASS_IDS) {
		const port = composeSvg(resolveCharacter({ class: id }), STILL);
		expectParity(await compare(`class-${LAB_KEY[id] ?? id}.svg`, port));
	}
}, 60_000);

test("every expression of the wizard draws what the lab drew", async () => {
	const wizard = resolveCharacter({ class: "wizard" });
	for (const expr of EXPRESSIONS)
		expectParity(
			await compare(
				`merlin-${expr}.svg`,
				composeSvg(wizard, { ...STILL, expr }),
			),
		);
}, 60_000);

test("the shield frame draws what the lab drew", async () => {
	const wizard = resolveCharacter({ class: "wizard" });
	expectParity(
		await compare(
			"billboard-merlin-shield.svg",
			composeSvg(wizard, { ...STILL, frame: "shield" }),
		),
	);
}, 60_000);

test("the comparison notices a change", async () => {
	const knight = resolveCharacter({ class: "knight" });
	const changed = composeSvg(
		resolveCharacter({ hat: "tricorn" }, knight),
		STILL,
	);
	const result = await compare("class-knight.svg", changed);
	expect(result.mean > MAX_MEAN_DIFFERENCE || result.far > MAX_FAR_SHARE).toBe(
		true,
	);
	const recolored = composeSvg(
		resolveCharacter({ palette: "azure" }, knight),
		STILL,
	);
	const color = await compare("class-knight.svg", recolored);
	expect(color.mean > MAX_MEAN_DIFFERENCE || color.far > MAX_FAR_SHARE).toBe(
		true,
	);
});
