import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { contrast as contrastRatio } from "./colors.ts";
import {
	AVATAR_STATES,
	accentOf,
	CATALOG,
	CharacterError,
	type CharacterInput,
	type CharacterLook,
	type CharacterSpec,
	CLASS_IDS,
	characterCss,
	checkSkins,
	composeSvg,
	EAST_ASIAN_SKINS,
	EXPRESSIONS,
	type Hex,
	parseCharacter,
	readCharacter,
	resolveCharacter,
	STATE_EXPRESSION,
	suggestCharacter,
} from "./index.ts";
import { ACCESSORIES, BEARDS, HAIR } from "./parts-hair.ts";
import { HATS } from "./parts-hats.ts";
import { OUTFITS } from "./parts-outfits.ts";
import { PROP_PIVOTS, PROPS } from "./parts-props.ts";

const DIR = import.meta.dir;
const FORBIDDEN = [
	"style=",
	"var(",
	"<style",
	"<script",
	"<text",
	"<image",
	"<foreignObject",
	"href",
];
const MAX_BYTES = 8 * 1024;

/** The invariants every composition keeps, whatever went in. */
function expectSafe(svg: string, uid = "a"): void {
	expect(svg.length).toBeLessThanOrEqual(MAX_BYTES);
	expect(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" `)).toBe(true);
	expect(svg.endsWith("</svg>")).toBe(true);
	expect(svg).toMatch(/viewBox="0 0 100 100"/);
	expect(svg).toMatch(/<svg [^>]*class="av( static)?"/);
	expect(svg).toMatch(/<svg [^>]*data-expr="[a-z]+"/);
	for (const word of FORBIDDEN) expect(svg).not.toContain(word);
	expect(svg).not.toMatch(/[\s"']on[a-z]+\s*=/i);
	expect(svg.match(/<svg/g)?.length).toBe(1);
	for (const [, id] of svg.matchAll(/ id="([^"]*)"/g))
		expect(id?.endsWith(uid)).toBe(true);
	for (const [, color] of svg.matchAll(/(?:fill|stroke)="([^"]*)"/g))
		expect(color).toMatch(/^(none|#[0-9a-f]{6}|#[0-9a-f]{3})$/);
}

const KNIGHT: CharacterSpec = {
	v: 1,
	class: "knight",
	outfit: "armor",
	hat: "helm",
	prop: "shield",
	hair: "short",
	beard: "none",
	accessory: "none",
	build: "regular",
	skin: 1,
	hairColor: "#6a4a33",
	colors: { primary: "#d8473d", secondary: "#fff1e4", trim: "#f0c04a" },
	palette: "gules",
};

function fieldOf(run: () => unknown): string | undefined {
	try {
		run();
	} catch (error) {
		if (error instanceof CharacterError) return error.field;
		throw error;
	}
	return undefined;
}

test("the catalog lists the lab's 24 classes, 13 expressions and 7 states", () => {
	expect(CLASS_IDS).toHaveLength(24);
	expect(EXPRESSIONS).toHaveLength(13);
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

test("all 24 classes in all 13 expressions and both frames compose safely within 8 KB", () => {
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

test("suggestCharacter picks a class from the role, a skin and an independent build from the name, and a palette no one has", () => {
	const suggest = (
		displayName: string,
		prompt = "",
		name = displayName.toLowerCase(),
	) => suggestCharacter({ name, displayName, prompt });
	expect(
		suggest("Reviewer", "You review code and decide whether it ships.").class,
	).toBe("knight");
	expect(suggest("Bot 醫生", "", "bot-doctor").class).toBe("healer");
	expect(suggest("Infra").class).toBe("engineer");
	expect(suggest("DevOps", "You keep CI green.").class).toBe("engineer");
	expect(
		suggest(
			"Helper",
			"You research papers and summarize the literature.",
			"helper",
		).class,
	).toBe("scholar");
	expect(suggest("維運小幫手", "").class).toBe("engineer");
	expect(suggest("審查員", "").class).toBe("knight");
	// A name hit outweighs a prompt hit.
	expect(
		suggest("Writer", "You review things, review again, and review more.")
			.class,
	).toBe("bard");
	// The result is a valid spec, deterministic, and varied by name.
	const first = suggest("Reviewer");
	expect(parseCharacter(first)).toEqual(first);
	expect(suggest("Reviewer")).toEqual(first);
	const looks = new Set(
		Array.from({ length: 40 }, (_, i) => {
			const spec = suggest("Reviewer", "", `reviewer-${i}`);
			return `${spec.skin}${spec.build}`;
		}),
	);
	expect(looks.size).toBeGreaterThan(5);
	// Build is its own draw: no skin implies a body type.
	const buildsBySkin = new Map<number, Set<string>>();
	for (let i = 0; i < 200; i++) {
		const spec = suggest("Reviewer", "", `reviewer-${i}`);
		const seen = buildsBySkin.get(spec.skin) ?? new Set<string>();
		seen.add(spec.build);
		buildsBySkin.set(spec.skin, seen);
	}
	for (const builds of buildsBySkin.values())
		expect(builds.size).toBeGreaterThan(1);
	// With no role to go by, the name's hash picks, among the classes not taken.
	const bland = (name: string, taken: CharacterSpec[] = []) =>
		suggestCharacter({ name, displayName: name, prompt: "Be helpful." }, taken);
	expect(bland("zzz").class).toBe(bland("zzz").class);
	const spread = new Set(
		Array.from({ length: 60 }, (_, i) => bland(`agent-${i}`).class),
	);
	expect(spread.size).toBeGreaterThan(10);
	const taken = CLASS_IDS.filter((id) => id !== "monk").map((id) =>
		resolveCharacter({ class: id }),
	);
	expect(bland("anything", taken).class).toBe("monk");
	// Never a repeated palette while fewer than 8 are taken.
	const names = Object.keys(CATALOG.palettes);
	const team: CharacterSpec[] = [];
	for (let i = 0; i < 8; i++) {
		const next = suggestCharacter(
			{ name: `member-${i}`, displayName: "Reviewer", prompt: "" },
			team,
		);
		expect(team.map((spec) => spec.palette)).not.toContain(next.palette);
		expect(names).toContain(next.palette as string);
		team.push(next);
	}
	// A taken spec with custom colors counts for no palette.
	const custom = resolveCharacter({
		class: "knight",
		colors: { primary: "#123456" },
	});
	expect(
		suggestCharacter({ name: "x", displayName: "x", prompt: "" }, [custom])
			.palette,
	).toBeDefined();
});

test("accentOf keeps a readable color on both schemes", () => {
	const luminance = (hex: string) => {
		const [r, g, b] = [1, 3, 5].map((at) => {
			const unit = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
			return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
		}) as [number, number, number];
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const contrast = (a: string, b: string) => {
		const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
			number,
			number,
		];
		return (hi + 0.05) / (lo + 0.05);
	};
	for (const palette of Object.keys(CATALOG.palettes)) {
		const spec = resolveCharacter({
			class: "wizard",
			palette: palette as never,
		});
		expect(contrast(accentOf(spec, "light"), "#ffffff")).toBeGreaterThanOrEqual(
			3,
		);
		expect(contrast(accentOf(spec, "dark"), "#0d1018")).toBeGreaterThanOrEqual(
			3,
		);
	}
	// A color that already reads is left alone.
	expect(
		accentOf(resolveCharacter({ class: "wizard", palette: "azure" }), "light"),
	).toBe("#3b6fd8");
	const pale = resolveCharacter({
		class: "wizard",
		colors: { primary: "#ffee88" },
	});
	expect(accentOf(pale, "light")).not.toBe("#ffee88");
	expect(accentOf(pale, "dark")).toBe("#ffee88");
});

test("accentOf reads at 3:1 on Camelot's parchment and night castle too", () => {
	const looks = {
		"camelot-light": ["#f4ead5", "#fbf5e6", "#eee1c3", "#e3d2a9", "#f2e4bd"],
		"camelot-dark": ["#0f1726", "#16213a", "#1c2a47", "#243557", "#222f4d"],
	} as const;
	for (const palette of Object.keys(CATALOG.palettes)) {
		const spec = resolveCharacter({
			class: "wizard",
			palette: palette as never,
		});
		for (const [look, surfaces] of Object.entries(looks))
			for (const surface of surfaces)
				expect(
					contrastRatio(accentOf(spec, look as never), surface),
				).toBeGreaterThanOrEqual(3);
	}
	// The plain schemes are the modern looks, unchanged.
	const wizard = resolveCharacter({ class: "wizard", palette: "azure" });
	expect(accentOf(wizard, "modern-light")).toBe(accentOf(wizard, "light"));
	expect(accentOf(wizard, "modern-dark")).toBe(accentOf(wizard, "dark"));
});

test("characters.css is exactly what characterCss() makes, and it carries every state and pivot", () => {
	const file = readFileSync(resolve(DIR, "characters.css"), "utf8");
	expect(file).toBe(characterCss());
	expect(file).not.toContain("style=");
	for (const state of AVATAR_STATES)
		expect(file).toContain(`[data-state=${state}]`);
	for (const prop of CATALOG.props)
		expect(file).toContain(`[data-prop=${prop}]`);
	expect(file).toContain("transform-box:view-box");
	expect(file).toContain("prefers-reduced-motion");
	expect(file).toContain(".av.static");
	// Every class the composer emits for motion has a rule.
	const svg = composeSvg(resolveCharacter({ class: "wizard" }));
	for (const [, name] of svg.matchAll(
		/class="(?:ov )?(o-[a-z]+|ch|eyes|prop|glow|ring)"/g,
	))
		expect(file).toContain(`.${name}`);
});

test("the kit imports nothing from node, canvas, bun or the core", () => {
	const files = readdirSync(DIR).filter(
		(name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
	);
	expect(files).toContain("index.ts");
	for (const name of files) {
		const source = readFileSync(resolve(DIR, name), "utf8");
		const specifiers = [
			...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g),
		].map((match) => match[1] as string);
		for (const specifier of specifiers) {
			expect(specifier.startsWith("node:")).toBe(false);
			expect(specifier).not.toMatch(/^(canvas|bun|bun:.*|fs|path|os)$/);
			expect(specifier).not.toMatch(/core/);
			if (specifier.startsWith("."))
				expect(specifier).toMatch(/^\.\/[a-z-]+\.ts$/);
		}
		expect(source).not.toMatch(/\b(Bun|process|require)\b\./);
	}
});

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
		expect(r).toBeGreaterThanOrEqual(0xcc);
		const luminance = (r + g + b) / 3;
		expect(luminance).toBeLessThan(lastLuminance);
		lastLuminance = luminance;
		// The ink of the eyes, brows and mouth reads at 5:1 or better on it.
		expect(contrastRatio("#2b2440", hex)).toBeGreaterThanOrEqual(5);
	}
	// Distinct enough to pick from.
	expect(new Set(EAST_ASIAN_SKINS).size).toBe(6);
});
