import { expect, test } from "bun:test";
import { characterCss } from "pi-roundtable/characters";
import { Home, loadChats, rooms, seed } from "./chats-fixture.tsx";
import {
	all,
	BUILD,
	foldersPage,
	page,
	q,
	SCOUT,
	TEAM,
	until,
	view,
} from "./folders-fixture.tsx";
import { store } from "./lib/app-store.ts";

foldersPage();

const show = async (node: React.ReactNode) => {
	await page.render(node);
	await until(() => all(".chat-row, .pin").length > 0);
};
const figureOf = (selector: string) =>
	q(`${selector} .av-host`)?.querySelector("svg.av") ?? null;

test("an idle figure on the home rests with closed eyes, and its kit stylesheet does not blink them", async () => {
	loadChats({ pins: [BUILD, SCOUT] });
	seed();
	await show(<Home />);
	await until(() => figureOf(`[data-room-pin="${BUILD}"]`) !== null);
	for (const room of [BUILD, SCOUT]) {
		const svg = figureOf(`[data-room-pin="${room}"]`);
		expect(svg?.getAttribute("data-expr")).toBe("resting");
		expect(svg?.querySelector(".eyes ellipse")).toBeNull();
	}
	// The kit's rule for a resting face leaves the eyes without any animation.
	expect(characterCss()).toContain(
		".av[data-expr=resting] .eyes{animation:none}",
	);
});

test("a working figure keeps its own expression and blinks at its own phase", async () => {
	loadChats({ pins: [BUILD, SCOUT] });
	seed();
	await show(<Home />);
	await page.act(() => {
		store.dispatch({
			type: "activity",
			room: SCOUT,
			typing: true,
			stoppable: true,
		});
	});
	await until(
		() =>
			figureOf(`[data-room-pin="${SCOUT}"]`)?.getAttribute("data-state") ===
			"working",
	);
	const working = figureOf(`[data-room-pin="${SCOUT}"]`);
	expect(working?.getAttribute("data-expr")).toBe("determined");
	expect(working?.querySelector(".eyes ellipse")).not.toBeNull();
	// The phase that offsets the blink is each pin's own.
	const phase = (room: string) =>
		q(`[data-room-pin="${room}"]`)?.style.getPropertyValue("--phase");
	expect(phase(SCOUT)).not.toBe(phase(BUILD));
	expect(characterCss()).toMatch(
		/\.av \.eyes\{[^}]*animation:av-blink 5\.2s[^}]*var\(--phase,\s*0s\)/,
	);
});

test("rows and a group's members rest with closed eyes too", async () => {
	loadChats({}, [
		...rooms().filter((one) => one.key !== TEAM),
		view(TEAM, { members: ["scout", "guide"] }),
	]);
	seed();
	await show(<Home />);
	await until(() => all(`[data-room="${TEAM}"] svg.av`).length === 2);
	for (const svg of all(`[data-room] svg.av`))
		expect(svg.getAttribute("data-expr")).toBe("resting");
});
