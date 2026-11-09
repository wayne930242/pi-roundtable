import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { contrast as contrastRatio } from "./colors.ts";
import { DIR } from "./fixtures/characters-fixture.ts";
import {
	AVATAR_STATES,
	accentOf,
	CATALOG,
	type CharacterSpec,
	CLASS_IDS,
	characterCss,
	composeSvg,
	parseCharacter,
	resolveCharacter,
	suggestCharacter,
} from "./index.ts";

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
