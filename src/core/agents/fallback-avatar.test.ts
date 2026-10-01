import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, loadImage } from "canvas";
import { fallbackAvatar } from "./fallback-avatar.ts";

const ICON = readFileSync(join(import.meta.dir, "..", "assets", "neutral.png"));

/** A picture's size and its pixels, to tell pictures apart without comparing encoders. */
async function look(bytes: Uint8Array) {
	const image = await loadImage(Buffer.from(bytes));
	return { width: image.width, height: image.height };
}

const NAMES = [
	"Researcher",
	"\u738b\u5c0f\u660e",
	"🤖 Robot Helper",
	"🤖🤖",
	"Émile",
	"\u3042\u3042",
	"\u0645\u0631\u062d\u0628\u0627",
	"A very long display name that goes on and on and on and on and on",
	"<b>&amp;</b>",
	"7",
];

const SLUG = "researcher";

describe("fallbackAvatar", () => {
	test("is a 512 px square PNG for every kind of name", async () => {
		for (const name of NAMES) {
			const bytes = await fallbackAvatar(name, ICON, SLUG);
			expect(bytes.subarray(1, 4).toString()).toBe("PNG");
			expect(await look(bytes)).toEqual({ width: 512, height: 512 });
		}
	});

	test("the same name and icon always give the same bytes", async () => {
		for (const name of ["Researcher", "\u738b\u5c0f\u660e", "🤖🤖"])
			expect(
				(await fallbackAvatar(name, ICON, SLUG)).equals(
					await fallbackAvatar(name, ICON, SLUG),
				),
			).toBe(true);
	});

	test("a name's normal form and surrounding spaces do not change its picture", async () => {
		const composed = await fallbackAvatar("\u00c9mile", ICON, "emile");
		expect(
			composed.equals(await fallbackAvatar("E\u0301mile  ", ICON, "emile")),
		).toBe(true);
	});

	test("different names give different pictures", async () => {
		const pictures = await Promise.all(
			NAMES.map((name) => fallbackAvatar(name, ICON, SLUG)),
		);
		expect(new Set(pictures.map((bytes) => bytes.toString("hex"))).size).toBe(
			NAMES.length,
		);
	});

	test("a different icon gives a different picture", async () => {
		const canvas = createCanvas(64, 64);
		canvas.getContext("2d").fillRect(0, 0, 64, 64);
		const other = await fallbackAvatar(
			"Researcher",
			canvas.toBuffer("image/png"),
			SLUG,
		);
		expect(other.equals(await fallbackAvatar("Researcher", ICON, SLUG))).toBe(
			false,
		);
	});

	test("the badge shows the initial of the agent's name, whatever script the display name uses", async () => {
		const shown = "\u738b\u5c0f\u660e";
		const a = await fallbackAvatar(shown, ICON, "alice");
		expect(a.equals(await fallbackAvatar(shown, ICON, "alice"))).toBe(true);
		expect(a.equals(await fallbackAvatar(shown, ICON, "bob"))).toBe(false);
		// Same colour, same initial: only the rest of the name is free to differ.
		expect(a.equals(await fallbackAvatar(shown, ICON, "alpha-2"))).toBe(true);
	});
});
