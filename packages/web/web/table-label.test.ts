import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ellipsize, fitLabel, MIN_NAME_PX } from "./table/label.ts";

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

test("the 2D table draws every name at 11 px or more on a narrow panel, and fits its ring inside its box", async () => {
	const { mountRoundTable } = await import("./table/entry.ts");
	const container = document.createElement("div");
	document.body.appendChild(container);
	// The stage the table draws into is laid out as 300 × 330 px.
	const sized = (name: "clientWidth" | "clientHeight", value: number) => {
		const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
		Object.defineProperty(HTMLElement.prototype, name, {
			configurable: true,
			get: () => value,
		});
		return () => {
			if (own) Object.defineProperty(HTMLElement.prototype, name, own);
			else
				delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
					name
				];
		};
	};
	const restore = [sized("clientWidth", 300), sized("clientHeight", 330)];
	const table = await mountRoundTable(
		container,
		{
			theme: "modern",
			scheme: "light",
			seats: Array.from({ length: 6 }, (_, index) => ({
				id: `s${index}`,
				name:
					["Archivist", "Scout", "Mason", "Cook", "Nurse", "Atlas"][index] ??
					"x",
				color: "#1f7a72",
			})),
			onSeatClick: () => undefined,
		},
		"svg",
	);
	const svg = container.querySelector("svg");
	const [, , width, height] = (svg?.getAttribute("viewBox") ?? "")
		.split(" ")
		.map(Number);
	expect(width).toBe(300);
	expect(height).toBe(330);
	for (const text of container.querySelectorAll("g.seat text")) {
		if ((text.textContent ?? "").length <= 2) continue;
		expect(Number(text.getAttribute("font-size"))).toBeGreaterThanOrEqual(
			MIN_NAME_PX,
		);
	}
	// The viewBox is the box's own size, so one unit is one CSS px and nothing is shrunk.
	for (const ellipse of container.querySelectorAll("svg > ellipse")) {
		const cx = Number(ellipse.getAttribute("cx"));
		const rx = Number(ellipse.getAttribute("rx"));
		expect(cx - rx).toBeGreaterThanOrEqual(-0.5);
		expect(cx + rx).toBeLessThanOrEqual((width ?? 0) + 0.5);
	}
	for (const plate of container.querySelectorAll("g.seat .plate")) {
		const g = plate.closest("g.seat");
		const match = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(
			g?.getAttribute("transform") ?? "",
		);
		const x = Number(match?.[1]);
		const w = Number(plate.getAttribute("width"));
		expect(x - w / 2).toBeGreaterThanOrEqual(-0.5);
		expect(x + w / 2).toBeLessThanOrEqual((width ?? 0) + 0.5);
	}
	table.dispose();
	for (const undo of restore) undo();
});

test("?nogl asks for the 2D table, wherever the query stands", async () => {
	const { glDisabled } = await import("./table/entry.ts");
	expect(glDisabled("?nogl", "")).toBe(true);
	expect(glDisabled("?x=1&nogl=1", "#/table")).toBe(true);
	expect(glDisabled("", "#/table?nogl")).toBe(true);
	expect(glDisabled("?nogl=0", "")).toBe(false);
	expect(glDisabled("?nogl=false", "#/table")).toBe(false);
	expect(glDisabled("", "#/table")).toBe(false);
	expect(glDisabled("?noglow", "")).toBe(false);
});
