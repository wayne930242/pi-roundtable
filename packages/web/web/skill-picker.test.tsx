import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import type { SkillChoiceView } from "../src/api-types.ts";
import { SKILL_ROWS, SkillPicker } from "./components/skill-picker.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { editApi } from "./lib/edit-api.ts";

let page: TestPage;
beforeAll(async () => {
	page = await openPage();
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});
let groups: ReturnType<typeof spyOn> | undefined;
afterEach(async () => {
	await page.render(null);
	groups?.mockRestore();
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));
const q = <T extends Element = HTMLElement>(selector: string) =>
	document.querySelector<T>(selector);
const all = <T extends Element = HTMLElement>(selector: string): T[] => [
	...document.querySelectorAll<T>(selector),
];
const named = (text: string) =>
	all<HTMLButtonElement>("button").find((one) => one.textContent === text) ??
	null;
const rows = () =>
	all(".skill-rows li strong").map((one) => one.textContent ?? "");

/** A built-in skill, two carried ones and eleven to add, one of them about drawing. */
const catalog = (): SkillChoiceView[] => [
	{ name: "core", source: "builtin", builtin: true, carried: true },
	{ name: "carried-a", source: "linked", builtin: false, carried: true },
	{ name: "carried-b", source: "linked", builtin: false, carried: true },
	...Array.from({ length: 11 }, (_, i) => ({
		name: `skill-${String(i).padStart(2, "0")}`,
		description: i === 4 ? "Use when drawing a map." : "Use when writing.",
		source: "linked" as const,
		builtin: false,
		carried: false,
	})),
];

async function draw(skills = catalog()) {
	groups = spyOn(editApi, "skillGroups").mockResolvedValue({
		groups: [
			{ name: "maps", description: "Maps.", skills: ["skill-04", "carried-a"] },
		],
	});
	const flips: [string, boolean][] = [];
	await page.render(
		<SkillPicker
			skills={skills}
			who="scout"
			onFlip={(skill, next) => flips.push([skill, next])}
			onApplyGroup={async () => ({ added: [], removed: [] })}
		/>,
	);
	await page.act(settle);
	return flips;
}

test("the carried skills are chips on top, the built-in ones one chip that stays, with the count", async () => {
	const flips = await draw();
	const chips = q(".skill-chips");
	expect(chips?.querySelector(".meta")?.textContent).toBe("3 carried");
	expect(chips?.querySelector("[data-builtin]")?.textContent).toBe(
		"1 built in",
	);
	expect(chips?.querySelector("[data-builtin]")?.tagName).toBe("SPAN");
	expect(
		all(".skill-chips button").map((one) => one.getAttribute("aria-label")),
	).toEqual(["Remove carried-a", "Remove carried-b"]);
	await page.click(q('button[aria-label="Remove carried-b"]'));
	expect(flips).toEqual([["carried-b", false]]);
});

test("the list shows what is not carried, folded to its first rows until Show all", async () => {
	const flips = await draw();
	expect(rows()).toHaveLength(SKILL_ROWS);
	expect(rows()).not.toContain("carried-a");
	await page.click(named("Show all (11)"));
	expect(rows()).toHaveLength(11);
	expect(named("Show all (11)")).toBeNull();
	const add = q<HTMLButtonElement>('.skill-rows button[aria-label="skill-03"]');
	expect(add?.getAttribute("aria-pressed")).toBe("false");
	await page.click(add);
	expect(flips).toEqual([["skill-03", true]]);
	// The description is one line; its button shows it whole.
	const text = q<HTMLButtonElement>(".skill-rows .skill-row-text");
	expect(text?.title).toBe("Use when writing.");
	expect(text?.getAttribute("aria-expanded")).toBe("false");
	await page.click(text);
	expect(text?.getAttribute("aria-expanded")).toBe("true");
});

test("the search matches names and descriptions and shows every match", async () => {
	await draw();
	const search = q<HTMLInputElement>(".skill-search input");
	expect(search?.getAttribute("aria-label")).toBe("Search Skills");
	const type = (text: string) =>
		page.act(() => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set?.call(search, text);
			search?.dispatchEvent(new Event("input", { bubbles: true }));
		});
	await type("MAP");
	expect(rows()).toEqual(["skill-04"]);
	await type("skill-1");
	expect(rows()).toEqual(["skill-10"]);
	await type("writing");
	expect(rows()).toHaveLength(10);
	expect(q(".skill-picker > button.compact")).toBeNull();
	await type("nothing like it");
	expect(q(".skill-rows")).toBeNull();
	expect(q(".skill-picker")?.textContent).toContain("Nothing matches.");
});

test("a group filters the list and offers its switch; Show carried lists the carried ones too", async () => {
	await draw();
	const maps = named("maps");
	expect(maps?.getAttribute("aria-pressed")).toBe("false");
	await page.click(maps);
	expect(maps?.getAttribute("aria-pressed")).toBe("true");
	expect(rows()).toEqual(["skill-04"]);
	expect(
		q('.skill-apply button[aria-label="Skill group maps"]'),
	).not.toBeNull();
	await page.click(named("Show carried"));
	expect(rows()).toEqual(["carried-a", "skill-04"]);
	expect(
		q('.skill-rows button[aria-label="carried-a"]')?.getAttribute(
			"aria-pressed",
		),
	).toBe("true");
	await page.click(maps);
	expect(q(".skill-apply")).toBeNull();
	expect(rows()).toHaveLength(SKILL_ROWS);
});
