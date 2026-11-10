import { expect, test } from "bun:test";
import { expectSafe, fieldOf, KNIGHT } from "./fixtures/characters-fixture.ts";
import {
	AVATAR_STATES,
	accentOf,
	CATALOG,
	type CharacterInput,
	type CharacterLook,
	type CharacterSpec,
	CLASS_IDS,
	composeSvg,
	EXPRESSIONS,
	PIVOTS,
	parseCharacter,
	readCharacter,
	resolveCharacter,
	STATE_EXPRESSION,
} from "./index.ts";
import { ACCESSORIES, BEARDS, HAIR } from "./parts-hair.ts";
import { HATS } from "./parts-hats.ts";
import { OUTFITS } from "./parts-outfits.ts";
import { PROP_PIVOTS, PROPS } from "./parts-props.ts";

test("the catalog lists the lab's 24 classes, 14 expressions and 7 states", () => {
	expect(CLASS_IDS).toHaveLength(24);
	expect(EXPRESSIONS).toHaveLength(14);
	expect(AVATAR_STATES).toHaveLength(7);
	expect(CATALOG.outfits).toHaveLength(15);
	expect(CATALOG.hats).toHaveLength(24);
	expect(CATALOG.props).toHaveLength(24);
	expect(CATALOG.hair).toHaveLength(8);
	expect(Object.keys(CATALOG.palettes)).toHaveLength(8);
	expect(CATALOG.skins).toHaveLength(6);
	expect(STATE_EXPRESSION).toEqual({
		idle: "neutral",
		thinking: "thinking",
		working: "determined",
		waiting: "curious",
		done: "proud",
		error: "apologetic",
		sleepy: "sleepy",
	});
	for (const id of CLASS_IDS) {
		const entry = CATALOG.classes[id];
		const english = entry.keywords.filter((word) => /^[ -~]+$/.test(word));
		expect(english.length).toBeGreaterThanOrEqual(4);
		expect(entry.keywords.length - english.length).toBeGreaterThanOrEqual(2);
		// A preset is a valid spec of its own class.
		expect(parseCharacter(resolveCharacter({ class: id }))).toEqual(
			resolveCharacter({ class: id }),
		);
	}
	expect(Object.isFrozen(CATALOG)).toBe(true);
	expect(Object.isFrozen(CATALOG.classes.wizard.preset.colors)).toBe(true);
});

test("every catalog id has a drawing and every drawing a catalog id", () => {
	const same = (ids: readonly string[], registry: object) =>
		expect([...ids].sort()).toEqual(Object.keys(registry).sort());
	same(CATALOG.outfits, OUTFITS);
	same(CATALOG.hats, HATS);
	same(CATALOG.props, PROPS);
	same(CATALOG.props, PROP_PIVOTS);
	same(CATALOG.hair, HAIR);
	same(CATALOG.beards, BEARDS);
	same(CATALOG.accessories, ACCESSORIES);
});

test("resolveCharacter gives a class its preset, and overrides over a base", () => {
	expect(resolveCharacter({ class: "knight" })).toEqual(KNIGHT);
	const red = resolveCharacter({ hat: "wreath", skin: 4 }, KNIGHT);
	expect(red).toEqual({ ...KNIGHT, hat: "wreath", skin: 4 });
	expect(KNIGHT.hat).toBe("helm");
	// A new class starts from that class's preset, not from the base.
	expect(resolveCharacter({ class: "wizard" }, KNIGHT).hat).toBe("wizard");
	// A palette sets all three colors; a custom color drops the palette name.
	const teal = resolveCharacter({ palette: "teal" }, KNIGHT);
	expect(teal.colors).toEqual(CATALOG.palettes.teal);
	expect(teal.palette).toBe("teal");
	const custom = resolveCharacter({ colors: { primary: "#ABCDEF" } }, teal);
	expect(custom.colors.primary).toBe("#abcdef");
	expect(custom.colors.secondary).toBe(CATALOG.palettes.teal.secondary);
	expect(custom.palette).toBeUndefined();
	expect("palette" in custom).toBe(false);
	// Colors equal to a preset name it again.
	expect(
		resolveCharacter({ colors: CATALOG.palettes.vert }, custom).palette,
	).toBe("vert");
	expect(fieldOf(() => resolveCharacter({}))).toBe("class");
	expect(fieldOf(() => resolveCharacter({ class: "pirate" } as never))).toBe(
		"class",
	);
	expect(fieldOf(() => resolveCharacter({ colour: "x" } as never))).toBe(
		"colour",
	);
	expect(
		fieldOf(() =>
			resolveCharacter({ colors: { glow: "#000000" } } as never, KNIGHT),
		),
	).toBe("colors.glow");
});

test("parseCharacter rejects what is not a complete, known spec and names the field", () => {
	expect(parseCharacter(KNIGHT)).toEqual(KNIGHT);
	expect(parseCharacter(JSON.parse(JSON.stringify(KNIGHT)))).toEqual(KNIGHT);
	const bad = (patch: Record<string, unknown>) =>
		fieldOf(() => parseCharacter({ ...KNIGHT, ...patch }));
	expect(bad({ extra: 1 })).toBe("extra");
	expect(bad({ hat: "tiara" })).toBe("hat");
	expect(bad({ hat: "</svg><script>" })).toBe("hat");
	expect(bad({ skin: 6 })).toBe("skin");
	expect(bad({ skin: "1" })).toBe("skin");
	expect(bad({ v: 2 })).toBe("v");
	expect(bad({ class: "pirate" })).toBe("class");
	expect(bad({ build: "tiny" })).toBe("build");
	expect(bad({ hairColor: "red" })).toBe("hairColor");
	expect(bad({ palette: "puce" })).toBe("palette");
	expect(bad({ palette: "teal" })).toBe("palette");
	const colors = (patch: Record<string, unknown>) =>
		fieldOf(() =>
			parseCharacter({ ...KNIGHT, colors: { ...KNIGHT.colors, ...patch } }),
		);
	expect(colors({ primary: "#fff" })).toBe("colors.primary");
	expect(colors({ primary: '#fff" onload="x' })).toBe("colors.primary");
	expect(colors({ secondary: "#12345g" })).toBe("colors.secondary");
	expect(colors({ trim: 0 })).toBe("colors.trim");
	expect(colors({ glow: "#ffffff" })).toBe("colors.glow");
	const { hat: _hat, ...incomplete } = KNIGHT;
	expect(fieldOf(() => parseCharacter(incomplete))).toBe("hat");
	for (const value of [null, undefined, 1, "knight", [], [KNIGHT]])
		expect(fieldOf(() => parseCharacter(value))).toBe("character");
	// An own __proto__ key from JSON.parse is an unknown key, not a prototype write.
	expect(
		fieldOf(() =>
			parseCharacter(JSON.parse(`{"__proto__":{"hat":"helm"},"v":1}`)),
		),
	).toBe("__proto__");
	expect(parseCharacter({ ...KNIGHT, hairColor: "#6A4A33" }).hairColor).toBe(
		"#6a4a33",
	);
});

test("readCharacter reads stored rows leniently and never throws", () => {
	expect(readCharacter(KNIGHT)).toEqual(KNIGHT);
	// An id this version does not know (a newer version wrote it) takes the class preset's.
	const newer = readCharacter({
		...KNIGHT,
		v: 2,
		prop: "jetpack",
		hat: "wreath",
		extra: true,
	});
	expect(newer).toEqual({ ...KNIGHT, hat: "wreath" });
	expect(
		readCharacter({ class: "wizard", skin: 9, hairColor: "nope" }),
	).toEqual(resolveCharacter({ class: "wizard" }));
	expect(
		readCharacter({ class: "knight", colors: { primary: "#000000", trim: 5 } })
			?.colors,
	).toEqual({ ...KNIGHT.colors, primary: "#000000" });
	expect(
		readCharacter({ class: "knight", colors: { primary: "#000000" } })?.palette,
	).toBeUndefined();
	expect(readCharacter({ class: "pirate" })).toBeUndefined();
	for (const value of [
		null,
		undefined,
		0,
		"x",
		[],
		[1],
		{},
		() => 1,
		Symbol("s"),
	])
		expect(readCharacter(value)).toBeUndefined();
	// Getters that throw are the caller's problem; plain garbage never reaches one.
	const result = readCharacter({
		class: "monk",
		colors: [],
		hat: {},
		skin: [],
	});
	expect(result).toEqual(resolveCharacter({ class: "monk" }));
});

/** The classes of the groups directly inside `g.ch`, and of the groups directly inside each of them. */
function figureGroups(svg: string): { top: string[]; inside: string[][] } {
	const top: string[] = [];
	const inside: string[][] = [];
	let depth = 0;
	let at = -1;
	const figure = svg.slice(
		svg.indexOf(`<g class="ch">`),
		svg.indexOf(`<g class="state"`),
	);
	for (const match of figure.matchAll(
		/<g\b(?: class="([^"]*)")?[^>]*>|<\/g>/g,
	)) {
		const tag = match[0];
		const name = match[1];
		if (tag === "</g>") {
			depth--;
			continue;
		}
		depth++;
		// Depth 1 is `g.ch`, depth 2 its parts, depth 3 what a part holds.
		if (name === "ch") continue;
		if (depth === 2) {
			top.push(name ?? "");
			inside.push([]);
			at++;
		} else if (depth === 3) inside[at]?.push(name ?? "");
	}
	return { top, inside };
}

test("one head group turns the head parts about the neck, and the hair behind it with it, for every class and hat", () => {
	const order = ["head", "hat", "eyes-brows", "mouth", "fx", "acc"];
	for (const id of CLASS_IDS)
		for (const hat of CATALOG.hats) {
			const spec = resolveCharacter({ hat }, resolveCharacter({ class: id }));
			const svg = composeSvg(spec, { bare: true, uid: "q9" });
			const { top, inside } = figureGroups(svg);
			const where = `${id} in a ${hat}`;
			// The head group sits between the body and the held item, and only the hair behind joins it.
			expect(
				top.filter((name) => name !== "back hd"),
				where,
			).toEqual(["body", "hd", "prop"]);
			if (top.includes("back hd")) expect(top[0], where).toBe("back hd");
			const parts = inside[top.indexOf("hd")] ?? [];
			expect(parts, where).toEqual(
				order.filter((name) => parts.includes(name)),
			);
			for (const required of ["head", "eyes-brows", "mouth"])
				expect(parts, where).toContain(required);
			// Nothing of the head is left outside the group.
			for (const name of order) expect(top, where).not.toContain(name);
			expect(svg.match(/class="hd"/g), where).toHaveLength(1);
		}
	// The neck: under the head's chin (it ends at y 77) and above the torso's top (71).
	expect(PIVOTS.neck).toBe("50px 76px");
});

test("all 24 classes in all 14 expressions and both frames compose safely within 8 KB", () => {
	for (const id of CLASS_IDS) {
		const spec = resolveCharacter({ class: id });
		for (const expr of EXPRESSIONS)
			for (const frame of ["disc", "shield"] as const) {
				const svg = composeSvg(spec, { expr, frame, uid: "q9" });
				expectSafe(svg, "q9");
				expect(svg).toContain(`data-expr="${expr}"`);
				expect(svg).toContain(`data-prop="${spec.prop}"`);
				// Live output carries every overlay.
				for (const overlay of ["o-think", "o-wait", "o-done", "o-err", "o-zz"])
					expect(svg).toContain(`class="ov ${overlay}"`);
				expect(composeSvg(spec, { expr, frame, uid: "q9" })).toBe(svg);
			}
	}
});

test("the layers keep the lab's order and a still carries only its state's overlay", () => {
	const svg = composeSvg(resolveCharacter({ class: "wizard" }));
	const order = [
		"frame",
		"ch",
		"body",
		"head",
		"hat",
		"eyes-brows",
		"mouth",
		"fx",
		"prop",
		"state",
	];
	let at = -1;
	for (const name of order) {
		const next = svg.indexOf(`class="${name}"`);
		expect(next).toBeGreaterThan(at);
		at = next;
	}
	const still = composeSvg(resolveCharacter({ class: "wizard" }), {
		still: true,
		state: "waiting",
		size: 64,
	});
	expect(still).toContain(`class="av static"`);
	expect(still).toContain(`data-state="waiting"`);
	expect(still).toContain(` width="64" height="64"`);
	expect(still).toContain("o-wait");
	for (const other of ["o-think", "o-done", "o-err", "o-zz"])
		expect(still).not.toContain(other);
	// A live figure leaves its state to the stylesheet.
	expect(svg).not.toContain("data-state");
	expect(svg).not.toContain(` width="`);
	// A figure with no label is hidden from assistive technology.
	expect(svg).toContain(`aria-hidden="true"`);
	const labelled = composeSvg(resolveCharacter({ class: "wizard" }), {
		label: "Wizard",
	});
	expect(labelled).toContain(`role="img" aria-label="Wizard"`);
	// An error bakes the red ring in, as the stylesheet does for a live one.
	expect(
		composeSvg(resolveCharacter({ class: "wizard" }), {
			state: "error",
			still: true,
		}),
	).toContain(`stroke="#e5484d"`);
	const bare = composeSvg(resolveCharacter({ class: "wizard" }), {
		bare: true,
		frame: "shield",
	});
	expect(bare).not.toContain("clipPath");
	expect(bare).not.toContain(`class="frame"`);
});

test("the looks only change the background and the ring", () => {
	const spec = resolveCharacter({ class: "bard" });
	const looks: CharacterLook[] = [
		"modern-light",
		"modern-dark",
		"camelot-light",
		"camelot-dark",
	];
	const frames = looks.map((look) => composeSvg(spec, { look }));
	expect(new Set(frames).size).toBe(4);
	const body = (svg: string) => svg.slice(svg.indexOf(`<g class="ch"`));
	expect(new Set(frames.map(body)).size).toBe(1);
	for (const svg of frames) expectSafe(svg);
});

function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

test("500 seeded random specs keep the invariants", () => {
	const random = seeded(20261028);
	const pick = <T>(list: readonly T[]): T =>
		list[Math.floor(random() * list.length)] as T;
	const hex = () =>
		`#${Math.floor(random() * 0x1000000)
			.toString(16)
			.padStart(6, "0")}` as const;
	const looks: CharacterLook[] = [
		"modern-light",
		"modern-dark",
		"camelot-light",
		"camelot-dark",
	];
	for (let i = 0; i < 500; i++) {
		const input: CharacterInput = {
			class: pick(CLASS_IDS),
			outfit: pick(CATALOG.outfits),
			hat: pick(CATALOG.hats),
			prop: pick(CATALOG.props),
			hair: pick(CATALOG.hair),
			beard: pick([...CATALOG.beards, "none"] as const),
			accessory: pick([...CATALOG.accessories, "none"] as const),
			build: pick(["slim", "regular", "stout"] as const),
			skin: pick([0, 1, 2, 3, 4, 5] as const),
			hairColor: hex(),
			colors: { primary: hex(), secondary: hex(), trim: hex() },
		};
		const spec = resolveCharacter(input);
		expect(parseCharacter(spec)).toEqual(spec);
		const uid = `r${i}`;
		const state = pick(AVATAR_STATES);
		const still = random() < 0.5;
		const svg = composeSvg(spec, {
			uid,
			state,
			still,
			expr: pick(EXPRESSIONS),
			look: pick(looks),
			frame: pick(["disc", "shield"] as const),
			bare: random() < 0.2,
			size: 1 + Math.floor(random() * 512),
			label: `agent ${i}`,
		});
		expectSafe(svg, uid);
		expect(accentOf(spec, pick(["light", "dark"] as const))).toMatch(
			/^#[0-9a-f]{6}$/,
		);
	}
});

test("hostile input is refused or escaped, never reaches the markup", () => {
	const spec = resolveCharacter({ class: "knight" });
	const cast = (patch: object) =>
		({ ...spec, ...patch }) as unknown as CharacterSpec;
	expect(fieldOf(() => composeSvg(cast({ hat: "</svg><script>" })))).toBe(
		"hat",
	);
	expect(
		fieldOf(() =>
			composeSvg(
				cast({ colors: { ...spec.colors, primary: '#fff" onload="x' } }),
			),
		),
	).toBe("colors.primary");
	expect(fieldOf(() => composeSvg(cast({ hairColor: "#000;fill:red" })))).toBe(
		"hairColor",
	);
	expect(fieldOf(() => composeSvg(spec, { uid: 'a"><script>' }))).toBe("uid");
	expect(fieldOf(() => composeSvg(spec, { uid: "ABC" }))).toBe("uid");
	expect(fieldOf(() => composeSvg(spec, { uid: "a".repeat(17) }))).toBe("uid");
	expect(fieldOf(() => composeSvg(spec, { size: 0 }))).toBe("size");
	expect(fieldOf(() => composeSvg(spec, { size: 1.5 }))).toBe("size");
	expect(fieldOf(() => composeSvg(spec, { expr: "evil" as never }))).toBe(
		"expr",
	);
	expect(fieldOf(() => composeSvg(spec, { look: "x" as never }))).toBe("look");
	expect(fieldOf(() => composeSvg(spec, { label: "x".repeat(201) }))).toBe(
		"label",
	);
	for (const label of [
		"<img src=x onerror=alert(1)>",
		'" onload="alert(1)',
		"</svg><script>alert(1)</script>",
		"style=display:none var(--x) href=javascript:1",
		"&amp; &#x3C;script&#x3E;",
	]) {
		const svg = composeSvg(spec, { label });
		expectSafe(svg);
		expect(svg).toContain("aria-label=");
		expect(svg.match(/aria-label="([^"]*)"/)?.[1]).not.toMatch(/[<>"'=()]/);
	}
});
