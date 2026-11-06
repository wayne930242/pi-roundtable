import { expect, test } from "bun:test";
import {
	agent,
	all,
	open,
	page,
	profile,
	q,
	settle,
	setupAgentSheet,
	tabNamed,
	typeInto,
	withHelpers,
} from "./agent-sheet-fixture.tsx";
import { closeAgentSheet, openAgentSheet } from "./lib/agent-sheet.ts";

setupAgentSheet();

const tabs = () =>
	all<HTMLButtonElement>(".agent-sheet [role=tab]").map((one) => ({
		label: one.textContent,
		selected: one.getAttribute("aria-selected") === "true",
	}));
const selected = () => tabs().find((one) => one.selected)?.label;
const visiblePanel = () =>
	all(".agent-sheet [role=tabpanel]").filter((one) => !one.hidden);

test("the sheet is tabs over one panel each, Profile first, and Presets only where the host makes temp knights", async () => {
	await open();
	const list = q(".agent-sheet [role=tablist]");
	expect(list?.getAttribute("aria-label")).toBe("Edit knight");
	expect(tabs().map((one) => one.label)).toEqual([
		"Profile",
		"Skills",
		"Look",
		"More",
	]);
	expect(selected()).toBe("Profile");
	const shown = visiblePanel();
	expect(shown).toHaveLength(1);
	const tab = tabNamed("Profile");
	expect(shown[0]?.getAttribute("aria-labelledby")).toBe(tab?.id ?? "");
	expect(tab?.getAttribute("aria-controls")).toBe(shown[0]?.id ?? "");
	expect(shown[0]?.querySelector("form")).not.toBeNull();
	closeAgentSheet();
	await page.render(null);

	withHelpers();
	await open();
	expect(tabs().map((one) => one.label)).toContain("Presets");
	closeAgentSheet();
	await page.render(null);
	// A temp knight has no presets of its own.
	agent.mockResolvedValue(
		profile({ helper: { parent: "app:agent.boss", parentName: "Boss" } }),
	);
	await open();
	expect(tabs().map((one) => one.label)).not.toContain("Presets");
});

test("the arrow keys, Home and End move among the tabs and show the one they land on", async () => {
	await open();
	const list = q(".agent-sheet [role=tablist]");
	const key = (name: string) =>
		page.act(() => {
			list?.dispatchEvent(
				new KeyboardEvent("keydown", { key: name, bubbles: true }),
			);
		});
	await key("ArrowRight");
	expect(selected()).toBe("Skills");
	expect(document.activeElement).toBe(tabNamed("Skills"));
	expect(tabNamed("Skills")?.tabIndex).toBe(0);
	expect(tabNamed("Profile")?.tabIndex).toBe(-1);
	expect(visiblePanel()[0]?.getAttribute("data-tab")).toBe("skills");
	await key("End");
	expect(selected()).toBe("More");
	await key("ArrowRight");
	expect(selected()).toBe("Profile");
	await key("ArrowLeft");
	expect(selected()).toBe("More");
	await key("Home");
	expect(selected()).toBe("Profile");
});

test("a tab asked for opens it, and look and skills still ask for theirs", async () => {
	await open();
	await page.act(() => openAgentSheet("scout", { tab: "more" }));
	await page.act(() => settle(40));
	expect(selected()).toBe("More");
	await page.act(() => openAgentSheet("scout", { skills: true }));
	await page.act(() => settle(40));
	expect(selected()).toBe("Skills");
	await page.act(() => openAgentSheet("scout", { look: true }));
	await page.act(() => settle(80));
	expect(selected()).toBe("Look");
	// Presets where the host has none shows the profile.
	await page.act(() => openAgentSheet("scout", { tab: "presets" }));
	await page.act(() => settle(40));
	expect(selected()).toBe("Profile");
});

test("an unsaved edit survives a trip to another tab", async () => {
	await open();
	await typeInto(q<HTMLInputElement>(".agent-sheet input"), "Scout Two");
	await page.click(tabNamed("Skills"));
	expect(q(".agent-sheet [data-tab=profile]")).toBeNull();
	await page.click(tabNamed("Profile"));
	expect(q<HTMLInputElement>(".agent-sheet input")?.value).toBe("Scout Two");
	expect(
		q<HTMLButtonElement>(".agent-sheet [data-tab=profile] button[type=submit]")
			?.disabled,
	).toBe(false);
});

test("the sheet opens on the tab shown last, for any knight, until a tab is asked for", async () => {
	await open();
	await page.click(tabNamed("More"));
	closeAgentSheet();
	await page.render(null);
	await open();
	expect(selected()).toBe("More");
	await page.act(() => openAgentSheet("scout", { tab: "skills" }));
	await page.act(() => settle(40));
	closeAgentSheet();
	await page.render(null);
	await open();
	expect(selected()).toBe("Skills");
});
