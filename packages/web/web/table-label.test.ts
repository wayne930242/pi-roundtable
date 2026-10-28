import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	ellipsize,
	fitLabel,
	MIN_NAME_PX,
	planPlates,
	plateOrder,
	rearLift,
} from "./table/label.ts";

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

const facts = (over: Partial<Parameters<typeof planPlates>[0]> = {}) => ({
	pxPerUnit: 40,
	plateWidth: 1.6,
	gap: 6,
	fontCell: 36,
	cellWidth: 256,
	...over,
});

test("a plate grows until its name is as large as MIN_NAME_PX on the screen", () => {
	// A narrow panel: 28/256 of a 1.6-unit plate at 40 px a unit is 7 px, so the plate has to grow.
	const plan = planPlates(facts());
	expect(plan.scale).toBeGreaterThan(1);
	expect(plan.px).toBeGreaterThanOrEqual(MIN_NAME_PX);
	expect(plan.names).toBe(true);
	// A large canvas needs no growth.
	expect(planPlates(facts({ pxPerUnit: 120 })).scale).toBe(1);
});

test("a plate grows to a comfortable size where the ring has room, and only to a readable one where it is crowded", () => {
	const roomy = planPlates(facts({ pxPerUnit: 40, gap: 6 }));
	const crowded = planPlates(
		facts({ pxPerUnit: 55, plateWidth: 1.25, gap: 1.83 }),
	);
	// Roomy: past the least; crowded: just over it, so the plate covers as little of its neighbours as it can.
	expect(roomy.px).toBeGreaterThan(MIN_NAME_PX + 1);
	expect(crowded.px).toBeGreaterThanOrEqual(MIN_NAME_PX);
	expect(crowded.px).toBeLessThan(MIN_NAME_PX + 0.5);
});

test("a plate stops growing before it runs into its neighbours, and then carries no name", () => {
	// 12 seats on a phone: the seats are 1.8 units apart, a 1.25-unit plate may grow by at most 1.3.
	const crowded = planPlates(
		facts({ pxPerUnit: 38, plateWidth: 1.25, gap: 1.83 }),
	);
	expect(crowded.scale).toBeLessThanOrEqual((0.95 * 1.83) / 1.25 + 1e-9);
	expect(crowded.px).toBeLessThan(MIN_NAME_PX);
	expect(crowded.names).toBe(false);
});

test("a name that is drawn is never below MIN_NAME_PX, at any canvas scale", () => {
	for (const pxPerUnit of [10, 20, 30, 40, 55, 80, 120]) {
		for (const gap of [1.8, 3, 6]) {
			const plan = planPlates(facts({ pxPerUnit, gap }));
			if (plan.names)
				expect(plan.px).toBeGreaterThanOrEqual(MIN_NAME_PX - 1e-6);
		}
	}
});

test("plates are drawn far to near, so a nearer plate is never covered by a farther one", () => {
	expect(plateOrder([0.2, -3, 3, -0.4])).toEqual([1, 3, 0, 2]);
	expect(plateOrder([1, 1, 1])).toEqual([0, 1, 2]);
});

test("a seat across the table is raised so its head clears the far edge, and the others are not", () => {
	expect(rearLift(1, 0.5)).toBe(0);
	expect(rearLift(0, 0.5)).toBe(0);
	expect(rearLift(-1, 0.5)).toBe(0.5);
	expect(rearLift(-0.5, 0.5)).toBeGreaterThan(0);
	expect(rearLift(-0.5, 0.5)).toBeLessThan(0.5);
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
