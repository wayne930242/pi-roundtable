import { expect, test } from "bun:test";
import { PIVOTS } from "pi-roundtable/characters";
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
import { CHATS_MOTION_CSS } from "./lib/chats-motion-style.ts";
import { CHATS_PARTS_CSS } from "./lib/chats-parts-style.ts";
import { seedUnread } from "./lib/host-state.ts";

foldersPage();

const show = async (node: React.ReactNode) => {
	await page.render(node);
	await until(() => q(".chats") !== null && all(".chat-row, .pin").length > 0);
};
const pin = (key: string) => q(`[data-room-pin="${key}"]`);

test("every figure rests with its own phase, so the pins do not breathe in step", async () => {
	loadChats({ pins: [BUILD, SCOUT] });
	seed();
	await show(<Home />);
	const phases = all(".pin, .chat-row").map((one) =>
		one.style.getPropertyValue("--phase"),
	);
	expect(phases.every((phase) => phase?.endsWith("s"))).toBe(true);
	expect(new Set(phases).size).toBeGreaterThan(1);
});

test("a working room shows it on its figure, and a new unread message pops the figure once", async () => {
	loadChats({ pins: [BUILD, SCOUT] });
	seed();
	await show(<Home />);
	expect(pin(SCOUT)?.hasAttribute("data-pop")).toBe(false);
	await page.act(() => {
		store.dispatch({
			type: "activity",
			room: SCOUT,
			typing: true,
			stoppable: true,
		});
	});
	expect(
		pin(SCOUT)?.querySelector(".av-host")?.getAttribute("data-state"),
	).toBe("working");
	await page.act(() => seedUnread({ [SCOUT]: 1 }));
	await until(() => pin(SCOUT)?.hasAttribute("data-pop") === true);
	expect(pin(BUILD)?.hasAttribute("data-pop")).toBe(false);
	// The pop ends by itself.
	await until(() => pin(SCOUT)?.hasAttribute("data-pop") === false, 3000);
	// Reading does not pop.
	await page.act(() => seedUnread({ [SCOUT]: 0 }));
	expect(pin(SCOUT)?.hasAttribute("data-pop")).toBe(false);
});

const SPLIT = (css: string): { selectors: string[]; body: string }[] => {
	// The rules outside @keyframes and @media, with comments gone.
	const plain = css
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/@keyframes [\w-]+ \{(?:[^{}]*\{[^{}]*\})*\s*\}/g, "")
		.replace(/@media [^{]*\{(?:[^{}]*\{[^{}]*\})*\s*\}/g, "");
	return [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((rule) => ({
		selectors: (rule[1] ?? "").split(",").map((one) => one.trim()),
		body: rule[2] ?? "",
	}));
};
const reducedOf = (css: string) =>
	css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));

test("the whole-figure motion is on the figure, not on the badge's disc, by transform alone, and stops for reduced motion", () => {
	for (const word of ["fig-breathe", "fig-pop", "transform-origin: 50% 100%"])
		expect(CHATS_MOTION_CSS).toContain(word);
	// No sway while working: the head and the item show it.
	expect(CHATS_MOTION_CSS).not.toContain("fig-sway");
	expect(CHATS_MOTION_CSS).toContain(":active");
	for (const { selectors, body } of SPLIT(CHATS_MOTION_CSS)) {
		for (const selector of selectors) {
			expect(selector).toMatch(
				/^(\.pin|\.chat-row|\[data-pin-item\]|\.pin\[|\.chat-row\[)/,
			);
			// The host holds the disc and the ring, so nothing moves it: only its svg.
			if (/animation|transform|transition/.test(body))
				expect(selector).toMatch(/> svg$/);
		}
	}
	const reduced = reducedOf(CHATS_MOTION_CSS);
	expect(reduced).toContain("animation: none");
	expect(CHATS_MOTION_CSS).not.toMatch(/\b(width|height|margin|top|left):/);
});

test("a lifted pin is not squashed or ducked by the press that lifted it", () => {
	for (const css of [CHATS_MOTION_CSS, CHATS_PARTS_CSS])
		for (const { selectors } of SPLIT(css))
			for (const selector of selectors)
				if (selector.includes(".pin:active"))
					expect(selector).toContain("[data-pin-item]:not([data-lifted])");
});

test("the parts move by transform and opacity alone, every rule in a pin or a row, never the host, and stop for reduced motion", () => {
	for (const word of [
		"hd-glance",
		"hd-ponder",
		"hd-nod",
		"hd-cock",
		"hd-shake",
		"hd-doze",
		"hd-perk",
		"it-sweep",
		"it-raise",
		"it-flourish",
		"it-drop",
		"it-hop",
	])
		expect(CHATS_PARTS_CSS).toContain(`@keyframes ${word} `);
	for (const [, body] of CHATS_PARTS_CSS.matchAll(
		/@keyframes [\w-]+ \{((?:[^{}]*\{[^{}]*\})*)\s*\}/g,
	))
		for (const [, name] of (body ?? "").matchAll(/([\w-]+):[^;]*;/g))
			expect(["transform", "opacity"]).toContain(name ?? "");
	expect(CHATS_PARTS_CSS).not.toMatch(/\b(width|height|margin|top|left):/);
	for (const { selectors, body } of SPLIT(CHATS_PARTS_CSS)) {
		for (const selector of selectors) {
			expect(selector).toMatch(/^(\.pin|\.chat-row|\[data-pin-item\])/);
			// Only the kit's `hd`, `prop` and body classes: never the groups inside the head, whose transform attributes a rule would override.
			expect(selector).not.toMatch(/\.(mouth|head|eyes|brows|hat)\b/);
			if (/animation|transform/.test(body) && !/--hd|--it/.test(body))
				expect(selector).not.toMatch(/\.av-host$|\.av-host\[[^\]]*\]$/);
		}
	}
	const reduced = reducedOf(CHATS_PARTS_CSS);
	expect(reduced).toContain("animation: none");
	for (const part of [".hd", ".prop"]) expect(reduced).toContain(part);
	// Not `transform: none` on everything: the mouth's own transform attribute would be overridden.
	expect(reduced).not.toMatch(/\*[^{]*\{[^}]*transform:/);
});

test("the head turns about the kit's neck", () => {
	const turn = SPLIT(CHATS_PARTS_CSS).find((rule) =>
		rule.selectors.includes(".pin .av .hd"),
	);
	expect(turn?.body).toContain(`transform-origin: ${PIVOTS.neck}`);
	expect(turn?.body).toContain("transform-box: view-box");
});

const parts = (row: Element | null, selector: string) => [
	...(row?.querySelectorAll(selector) ?? []),
];

test("a pin moves its parts at rest, a row at rest stands still inside and moves them once its agent works", async () => {
	loadChats({ pins: [BUILD] });
	seed();
	await show(<Home />);
	await until(() => parts(pin(BUILD), ".av .hd").length > 0);
	// The kit draws the head as one group about the neck: the hair behind it and the head's parts.
	expect(parts(pin(BUILD), ".av .hd").length).toBeGreaterThanOrEqual(1);
	expect(parts(pin(BUILD), ".av .prop")).toHaveLength(1);
	const host = (room: string) =>
		q(`[data-room="${room}"] .av-host`) ??
		q(`[data-room-pin="${room}"] .av-host`);
	expect(host(BUILD)?.classList.contains("static")).toBe(false);
	await until(() => q(`[data-room="${SCOUT}"] .av-host`) !== null);
	expect(
		q(`[data-room="${SCOUT}"] .av-host`)?.classList.contains("static"),
	).toBe(true);
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
			q(`[data-room="${SCOUT}"] .av-host`)?.classList.contains("static") ===
			false,
	);
	const row = q(`[data-room="${SCOUT}"] .av-host`);
	expect(row?.classList.contains("static")).toBe(false);
	expect(row?.getAttribute("data-state")).toBe("working");
});

test("a group's stack moves each member's parts by the row's rule, each at a phase of its own", async () => {
	loadChats({}, [
		...rooms().filter((one) => one.key !== TEAM),
		view(TEAM, { members: ["scout", "guide"] }),
	]);
	seed();
	await show(<Home />);
	const members = () => all(`[data-room="${TEAM}"] .av-stack-item`);
	await until(() => members().length === 2);
	expect(members()).toHaveLength(2);
	const phases = members().map((one) =>
		(one.firstElementChild as HTMLElement | null)?.style.getPropertyValue(
			"--phase",
		),
	);
	expect(phases.every((phase) => phase?.endsWith("s"))).toBe(true);
	expect(new Set(phases).size).toBe(2);
	const stood = () =>
		members().map((one) =>
			one.querySelector(".av-host")?.classList.contains("static"),
		);
	// At rest each member is still inside, as an agent's row is.
	expect(stood()).toEqual([true, true]);
	await page.act(() => {
		store.dispatch({
			type: "activity",
			room: TEAM,
			typing: true,
			stoppable: true,
		});
	});
	await until(() => stood().every((one) => one === false));
	expect(stood()).toEqual([false, false]);
	for (const one of members()) {
		expect(one.querySelector(".av-host")?.getAttribute("data-state")).toBe(
			"working",
		);
		await until(() => one.querySelector(".av .hd") !== null);
		expect(one.querySelector(".av .hd")).not.toBeNull();
		expect(one.querySelector(".av .prop")).not.toBeNull();
	}
});
