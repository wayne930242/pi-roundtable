import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ellipsize, fitLabel } from "./table/label.ts";

beforeAll(() => GlobalRegistrator.register({ width: 390, height: 844 }));
afterAll(() => GlobalRegistrator.unregister());

test("a name that fits is shown whole", () => {
	expect(fitLabel("Lancelot", 6)).toBe("Lancelot");
	expect(fitLabel("\u5713\u684c\u9a0e\u58eb", 5)).toBe(
		"\u5713\u684c\u9a0e\u58eb",
	);
});

test("a name longer than the plate is cut with an ellipsis, never mid-glyph", () => {
	const cut = fitLabel("Sir Lancelot du Lac of the Round Table", 6);
	expect(cut.endsWith("…")).toBe(true);
	expect(cut.length).toBeLessThan(14);
	// CJK glyphs are as wide as the em, so fewer of them fit.
	expect(
		fitLabel(
			"\u5713\u684c\u9a0e\u58eb\u5718\u7684\u7b2c\u4e00\u4f4d\u9a0e\u58eb",
			5,
		),
	).toBe("\u5713\u684c\u9a0e\u58eb…");
	expect(fitLabel("😀😀😀😀😀😀😀😀😀😀", 3)).toMatch(/^(?:😀)+…$/u);
});

test("ellipsize keeps at least the ellipsis, and trims the space before it", () => {
	expect(ellipsize("ab cd", (text) => text.length <= 3)).toBe("ab…");
	expect(ellipsize("abc", () => false)).toBe("…");
});

test("the 2D table shows a long seat name cut, a short one whole, and names every seat in full for assistive tech", async () => {
	const { mountRoundTable } = await import("./table/entry.ts");
	const container = document.createElement("div");
	document.body.appendChild(container);
	const table = await mountRoundTable(container, {
		theme: "modern",
		scheme: "light",
		seats: [
			{ id: "a", name: "Lancelot", color: "#1f7a72" },
			{ id: "b", name: "Sir Bedivere of the Long Names", color: "#b8872b" },
		],
		onSeatClick: () => undefined,
	});
	const texts = [...container.querySelectorAll("g.seat")].map((seat) => ({
		label: seat.getAttribute("aria-label"),
		text: [...seat.querySelectorAll("text")]
			.map((node) => node.textContent)
			.find((text) => text && text.length > 2),
	}));
	expect(texts[0]?.text).toBe("Lancelot");
	expect(texts[1]?.text?.endsWith("…")).toBe(true);
	expect(texts[1]?.label).toContain("Sir Bedivere of the Long Names");
	table.dispose();
});

test("two tables on one page never share a gradient id", async () => {
	const { mountRoundTable } = await import("./table/entry.ts");
	const make = async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		return mountRoundTable(container, {
			theme: "camelot",
			scheme: "dark",
			seats: [{ id: "a", name: "A", color: "#1f7a72" }],
			onSeatClick: () => undefined,
			variant: "compact",
		});
	};
	const [first, second] = [await make(), await make()];
	const ids = [...document.querySelectorAll("[id]")].map((node) => node.id);
	expect(ids.length).toBeGreaterThan(2);
	expect(new Set(ids).size).toBe(ids.length);
	first.dispose();
	second.dispose();
});
