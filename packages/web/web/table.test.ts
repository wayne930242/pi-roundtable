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

const seatNames = (container: HTMLElement) =>
	[...container.querySelectorAll("g.seat[data-seat]")].map((seat) =>
		seat.getAttribute("data-seat"),
	);

test("a seat that leaves the 2D table fades out inside a puff while the others take their new places", async () => {
	const { container, table } = await mount();
	// the seats of the first draw are no arrival
	expect(container.querySelector(".seat-in, .seat-out")).toBeNull();
	table.setSeats(seats().filter((seat) => seat.id !== "lancelot"));
	expect(seatNames(container)).toEqual(["arthur", "gawain"]);
	const ghost = container.querySelector("g.seat-out");
	expect(ghost).not.toBeNull();
	// the leaver is only a picture now: not a button, not a menu target
	expect(ghost?.getAttribute("data-seat")).toBeNull();
	expect(ghost?.getAttribute("role")).toBeNull();
	expect(ghost?.getAttribute("aria-hidden")).toBe("true");
	expect(ghost?.querySelectorAll("circle.puff").length).toBeGreaterThan(2);
	table.dispose();
	// disposing puts the show away with the table
	expect(container.querySelector("g.seat-out")).toBeNull();
});

test("a seat that joins the 2D table rises over a ring on the floor", async () => {
	const { container, table } = await mount();
	table.setSeats(seats().filter((seat) => seat.id !== "lancelot"));
	container.querySelector("g.seat-out")?.remove();
	table.setSeats(seats());
	const joined = container.querySelector('g.seat[data-seat="lancelot"]');
	expect(joined?.classList.contains("seat-in")).toBe(true);
	expect(joined?.querySelector("ellipse.seat-ring")).not.toBeNull();
	expect(container.querySelectorAll("g.seat-in")).toHaveLength(1);
	table.dispose();
});

test("the same people in another order, or a state change, play no show", async () => {
	const { container, table } = await mount();
	table.setSeats([...seats()].reverse());
	table.setState("arthur", "thinking");
	expect(container.querySelector(".seat-in, .seat-out")).toBeNull();
	table.dispose();
});

test("a right click and the Menu key on a seat ask the page for its menu", async () => {
	const asked: Array<{ id: string; via: string }> = [];
	const { container, table, clicked } = await mount({
		listBelow: true,
		onSeatMenu: (request) =>
			void asked.push({ id: request.id, via: request.via }),
	});
	const seat = container.querySelector('g.seat[data-seat="lancelot"]');
	seat?.dispatchEvent(
		new MouseEvent("contextmenu", {
			bubbles: true,
			cancelable: true,
			clientX: 40,
			clientY: 50,
		}),
	);
	const button = container.querySelector<HTMLButtonElement>(
		'.rt-table-list button[data-seat="gawain"]',
	);
	button?.dispatchEvent(
		new KeyboardEvent("keydown", {
			key: "ContextMenu",
			bubbles: true,
			cancelable: true,
		}),
	);
	expect(asked).toEqual([
		{ id: "lancelot", via: "contextmenu" },
		{ id: "gawain", via: "key" },
	]);
	// a click is still a click
	button?.click();
	expect(clicked).toEqual(["gawain"]);
	table.dispose();
});

test("without a menu handler the table adds no menu gestures: a right click is the browser's own", async () => {
	const { container, table } = await mount();
	const event = new MouseEvent("contextmenu", {
		bubbles: true,
		cancelable: true,
	});
	container.querySelector('g.seat[data-seat="arthur"]')?.dispatchEvent(event);
	expect(event.defaultPrevented).toBe(false);
	table.dispose();
});
