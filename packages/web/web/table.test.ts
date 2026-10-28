import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { composeSvg, resolveCharacter } from "pi-roundtable/characters";
import type { SeatInit, TableOptions } from "./table/entry.ts";

// happy-dom has no WebGL, so the module must take the 2D path the way a browser without WebGL does.
beforeAll(() => GlobalRegistrator.register({ width: 390, height: 844 }));
afterAll(() => GlobalRegistrator.unregister());

const seats = (): SeatInit[] =>
	["arthur", "lancelot", "gawain"].map((id, index) => ({
		id,
		name: id,
		color: ["#1f7a72", "#b8872b", "#a5435f"][index] ?? "#000000",
	}));

async function mount(over: Partial<TableOptions> = {}) {
	const { mountRoundTable } = await import("./table/entry.ts");
	const clicked: string[] = [];
	const container = document.createElement("div");
	document.body.appendChild(container);
	const table = await mountRoundTable(container, {
		theme: "camelot",
		scheme: "dark",
		seats: seats(),
		onSeatClick: (seat) => void clicked.push(seat.id),
		reducedMotion: "auto",
		lowPower: "auto",
		...over,
	});
	return { container, table, clicked };
}

test("without WebGL the table mounts as SVG and never adds a style element", async () => {
	const { container, table } = await mount();
	expect(table.kind).toBe("svg");
	expect(container.querySelector("style")).toBeNull();
	expect(container.querySelectorAll("[data-state]")).toHaveLength(3);
	table.dispose();
	expect(container.querySelector("svg")).toBeNull();
});

test("setState sets the seat's data-state", async () => {
	const { container, table } = await mount();
	table.setState("lancelot", "waiting");
	const states = [...container.querySelectorAll("[data-state]")].map((seat) =>
		seat.getAttribute("data-state"),
	);
	expect(states.filter((state) => state === "waiting")).toHaveLength(1);
	expect(
		container.querySelector("[data-state=waiting]")?.textContent,
	).toContain("lancelot");
	table.dispose();
});

test("the compact variant is the 2D strip", async () => {
	const { container, table } = await mount({ variant: "compact" });
	expect(table.kind).toBe("svg");
	expect(container.querySelector("[data-variant=compact]")).not.toBeNull();
	expect(container.querySelector("canvas")).toBeNull();
	table.dispose();
});

test("listBelow shows a visible button per seat that opens the seat", async () => {
	const { container, table, clicked } = await mount({ listBelow: true });
	const buttons = [
		...container.querySelectorAll<HTMLButtonElement>(".rt-table-list button"),
	];
	expect(buttons.map((button) => button.textContent)).toEqual([
		"arthur (idle)",
		"lancelot (idle)",
		"gawain (idle)",
	]);
	table.setState("gawain", "error");
	expect(buttons[2]?.isConnected).toBe(true);
	container
		.querySelector<HTMLButtonElement>(".rt-table-list li:last-child button")
		?.click();
	expect(clicked).toEqual(["gawain"]);
	expect(
		container.querySelector(".rt-table-list li:last-child")?.textContent,
	).toBe("gawain (error)");
	table.dispose();
});

test("composed shield characters, each with its own uid, go in as data URIs", async () => {
	const { container, table } = await mount();
	const spec = resolveCharacter({ class: "wizard" });
	const svg = (uid: string) =>
		composeSvg(spec, {
			frame: "shield",
			look: "camelot-dark",
			expr: "neutral",
			state: "idle",
			still: true,
			size: 256,
			uid,
		});
	const [first, second] = [svg("arthur"), svg("lancelot")];
	expect(first).not.toBe(second);
	await table.setAvatar("arthur", first);
	await table.setAvatar("lancelot", second);
	const hrefs = [...container.querySelectorAll("image")].map((image) =>
		image.getAttribute("href"),
	);
	expect(hrefs).toHaveLength(2);
	for (const href of hrefs) expect(href).toMatch(/^data:image\/svg\+xml/);
	table.dispose();
});
