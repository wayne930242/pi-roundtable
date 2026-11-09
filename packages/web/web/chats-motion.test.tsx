import { expect, test } from "bun:test";
import { Home, loadChats, seed } from "./chats-fixture.tsx";
import {
	all,
	BUILD,
	foldersPage,
	page,
	q,
	SCOUT,
	until,
} from "./folders-fixture.tsx";
import { store } from "./lib/app-store.ts";
import { CHATS_MOTION_CSS } from "./lib/chats-motion-style.ts";
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
	expect(phases.every((phase) => phase.endsWith("s"))).toBe(true);
	expect(new Set(phases).size).toBeGreaterThan(1);
	expect(pin(BUILD)?.getAttribute("data-motion")).toBe("idle");
});

test("a working room sways, and a new unread message pops the figure once", async () => {
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
	expect(pin(SCOUT)?.getAttribute("data-motion")).toBe("working");
	await page.act(() => seedUnread({ [SCOUT]: 1 }));
	await until(() => pin(SCOUT)?.hasAttribute("data-pop") === true);
	expect(pin(BUILD)?.hasAttribute("data-pop")).toBe(false);
	// The pop ends by itself.
	await until(() => pin(SCOUT)?.hasAttribute("data-pop") === false, 3000);
	// Reading does not pop.
	await page.act(() => seedUnread({ [SCOUT]: 0 }));
	expect(pin(SCOUT)?.hasAttribute("data-pop")).toBe(false);
});

test("the motion moves the whole figure by transform alone, rows more gently, and stops for reduced motion", () => {
	for (const word of [
		"fig-breathe",
		"fig-sway",
		"fig-pop",
		"transform-origin: 50% 100%",
	])
		expect(CHATS_MOTION_CSS).toContain(word);
	expect(CHATS_MOTION_CSS).toContain(".chat-row");
	expect(CHATS_MOTION_CSS).toContain(":active");
	const reduced = CHATS_MOTION_CSS.slice(
		CHATS_MOTION_CSS.indexOf("@media (prefers-reduced-motion: reduce)"),
	);
	expect(reduced).toContain("animation: none");
	// Nothing in it changes layout.
	expect(CHATS_MOTION_CSS).not.toMatch(/\b(width|height|margin|top|left):/);
});
