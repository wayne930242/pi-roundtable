import { expect, test } from "bun:test";
import { contrast as contrastRatio } from "./colors.ts";
import { expectSafe, fieldOf, KNIGHT } from "./fixtures/characters-fixture.ts";
import {
	CATALOG,
	checkSkins,
	composeSvg,
	EAST_ASIAN_SKINS,
	EXPRESSIONS,
	type Hex,
} from "./index.ts";

const SKIN_FILL = (svg: string): string[] =>
	[
		...svg.matchAll(/<circle cx="22.6" cy="54" r="4.2" fill="(#[0-9a-f]{6})"/g),
	].map((match) => match[1] as string);

test("the default skins are the six the package shipped, light to dark", () => {
	expect([...CATALOG.skins]).toEqual([
		"#f7d6b8",
		"#eab98c",
		"#d4a070",
		"#b9784c",
		"#8e5b3c",
		"#5c3a26",
	]);
	for (const skin of [0, 1, 2, 3, 4, 5] as const) {
		const spec = { ...KNIGHT, skin };
		expect(SKIN_FILL(composeSvg(spec))).toEqual([
			CATALOG.skins[skin] as string,
		]);
		// An explicit list of the defaults draws the same picture as none.
		expect(composeSvg(spec, { skins: CATALOG.skins })).toBe(composeSvg(spec));
	}
});

test("a host's skins replace the catalog's in every look, frame and state, and the index stays", () => {
	const mine: Hex[] = [
		"#ffffff",
		"#fafafa",
		"#f0f0f0",
		"#e0e0e0",
		"#d0d0d0",
		"#c0c0c0",
	];
	for (const skin of [0, 1, 2, 3, 4, 5] as const) {
		const spec = { ...KNIGHT, skin };
		for (const look of ["modern-light", "camelot-dark"] as const)
			for (const frame of ["disc", "shield"] as const) {
				const svg = composeSvg(spec, {
					skins: mine,
					look,
					frame,
					state: "idle",
				});
				expect(SKIN_FILL(svg)).toEqual([mine[skin] as string]);
				expectSafe(svg);
			}
	}
	// Mixed-case hexes are accepted and drawn lower-cased.
	expect(
		SKIN_FILL(composeSvg(KNIGHT, { skins: ["#AABBCC", ...mine.slice(1)] })),
	).toEqual(["#fafafa"]);
});

test("a skins option that is not six #rrggbb colors is refused and names the place", () => {
	const six: Hex[] = [...CATALOG.skins];
	const field = (skins: unknown) =>
		fieldOf(() => composeSvg(KNIGHT, { skins: skins as never }));
	expect(field(six.slice(0, 5))).toBe("skins");
	expect(field([...six, "#ffffff"])).toBe("skins");
	expect(field("#ffffff")).toBe("skins");
	expect(field(null)).toBe("skins");
	expect(field([...six.slice(0, 5), "red"])).toBe("skins[5]");
	expect(field([...six.slice(0, 2), "#fff", ...six.slice(3)])).toBe("skins[2]");
	expect(field([...six.slice(0, 5), 123])).toBe("skins[5]");
	expect(field([...six.slice(0, 5), "#12345g"])).toBe("skins[5]");
	expect(field(new Array(6))).toBe("skins[0]");
	expect(() => checkSkins(six, "characters.skins")).not.toThrow();
	expect(fieldOf(() => checkSkins(six.slice(1), "characters.skins"))).toBe(
		"characters.skins",
	);
});

test("EAST_ASIAN_SKINS is six light, warm-pink to peach tones the face lines read on", () => {
	expect(EAST_ASIAN_SKINS).toHaveLength(6);
	expect(Object.isFrozen(EAST_ASIAN_SKINS)).toBe(true);
	expect(() => checkSkins(EAST_ASIAN_SKINS)).not.toThrow();
	let lastLuminance = 256;
	for (const hex of EAST_ASIAN_SKINS) {
		const [r, g, b] = [1, 3, 5].map((at) =>
			Number.parseInt(hex.slice(at, at + 2), 16),
		) as [number, number, number];
		// Warm, never green or yellow: red leads, blue trails, green sits between and close to red.
		expect(r).toBeGreaterThan(g);
		expect(g).toBeGreaterThan(b);
		const hue = (60 * (g - b)) / (r - Math.min(g, b));
		expect(hue).toBeGreaterThanOrEqual(18);
		expect(hue).toBeLessThanOrEqual(30);
		// Light: every tone is lighter than the default's second tone, and they darken one by one.
		expect(r).toBeGreaterThanOrEqual(0xe9);
		const luminance = (r + g + b) / 3;
		expect(luminance).toBeLessThan(lastLuminance);
		lastLuminance = luminance;
		// The ink of the eyes, brows and mouth reads at 5:1 or better on it.
		expect(contrastRatio("#2b2440", hex)).toBeGreaterThanOrEqual(5);
	}
	// Distinct enough to pick from.
	expect(new Set(EAST_ASIAN_SKINS).size).toBe(6);
});

test("a mouth option draws the two frames of a talking figure in every expression, and leaves the rest of the face as it is", () => {
	const mouthOf = (svg: string) =>
		svg.match(/<g class="mouth"[^>]*>(.*?)<\/g>/)?.[1] ?? "";
	const without = (svg: string) => svg.replace(mouthOf(svg), "");
	for (const expr of EXPRESSIONS) {
		const own = composeSvg(KNIGHT, { expr, uid: "m1" });
		const open = composeSvg(KNIGHT, { expr, uid: "m1", mouth: "open" });
		const closed = composeSvg(KNIGHT, { expr, uid: "m1", mouth: "closed" });
		expectSafe(open, "m1");
		expectSafe(closed, "m1");
		// an open mouth is filled with the ink, a closed one is a line
		expect(mouthOf(open)).toMatch(/<(ellipse|path)[^>]*fill="#/);
		expect(mouthOf(closed)).not.toContain("<ellipse");
		expect(mouthOf(closed)).toContain('fill="none"');
		expect(mouthOf(open)).not.toBe(mouthOf(closed));
		// one of the two is the expression's own mouth, and only the mouth changes
		expect([mouthOf(open), mouthOf(closed)]).toContain(mouthOf(own));
		expect(without(open)).toBe(without(own));
		expect(without(closed)).toBe(without(own));
	}
	expect(
		fieldOf(() => composeSvg(KNIGHT, { mouth: "wide" as unknown as "open" })),
	).toBe("mouth");
});
