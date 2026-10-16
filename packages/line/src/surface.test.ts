import { expect, test } from "bun:test";
import { partial } from "pi-roundtable/testing";
import type { LineOutbox } from "./outbox.ts";
import { LineSurface } from "./surface.ts";

const outbox = partial<LineOutbox>({});

test("the surface tells the model that LINE shows plain text, so Markdown would appear as symbols", () => {
	const told = new LineSurface(outbox).formatting;
	expect(told).toContain("plain text only");
	expect(told).toContain(
		"no headings, tables, bold, code fences or link syntax",
	);
	expect(told?.length).toBeLessThan(400);
});

test("a text replaces the guidance, and false removes it", () => {
	expect(new LineSurface(outbox, "Short and bare.").formatting).toBe(
		"Short and bare.",
	);
	expect(new LineSurface(outbox, false).formatting).toBeUndefined();
});

test("a text with nothing in it is refused, not read as none", () => {
	expect(() => new LineSurface(outbox, "")).toThrow("formatting is empty");
});
