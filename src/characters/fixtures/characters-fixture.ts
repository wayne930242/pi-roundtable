import { expect } from "bun:test";
import { resolve } from "node:path";
import { CharacterError, type CharacterSpec } from "../index.ts";

/** The characters directory, one up from the fixtures. */
export const DIR = resolve(import.meta.dir, "..");

export const FORBIDDEN = [
	"style=",
	"var(",
	"<style",
	"<script",
	"<text",
	"<image",
	"<foreignObject",
	"href",
];

export const MAX_BYTES = 8 * 1024;

/** The invariants every composition keeps, whatever went in. */
export function expectSafe(svg: string, uid = "a"): void {
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

export const KNIGHT: CharacterSpec = {
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

export function fieldOf(run: () => unknown): string | undefined {
	try {
		run();
	} catch (error) {
		if (error instanceof CharacterError) return error.field;
		throw error;
	}
	return undefined;
}
