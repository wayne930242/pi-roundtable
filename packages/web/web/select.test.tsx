import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SELECT_CSS, Select } from "./components/select.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";

let page: TestPage;
beforeAll(async () => {
	page = await openPage();
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});

const here = import.meta.dir;
const walk = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? walk(join(dir, entry.name))
			: entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")
				? [join(dir, entry.name)]
				: [],
	);

test("a drop-down is the native control with one chevron after it, and the wrapper takes the layout class", async () => {
	await page.render(
		<Select aria-label="Pick" className="mine" defaultValue="b">
			<option value="a">A</option>
			<option value="b">B</option>
		</Select>,
	);
	const box = page.container.querySelector(".select");
	expect(box?.classList.contains("mine")).toBe(true);
	const control = box?.querySelector("select");
	expect(control?.getAttribute("aria-label")).toBe("Pick");
	expect(control?.value).toBe("b");
	expect(box?.querySelectorAll("svg").length).toBe(1);
	expect(box?.hasAttribute("data-chip")).toBe(false);
});

test("the chip variant is marked for the pill that stands beside the breadcrumbs", async () => {
	await page.render(
		<Select chip aria-label="Pick">
			<option>A</option>
		</Select>,
	);
	expect(
		page.container.querySelector(".select")?.hasAttribute("data-chip"),
	).toBe(true);
});

test("a list box stays the native control: no wrapper, no chevron", async () => {
	await page.render(
		<Select aria-label="Pick" size={6} className="mine">
			<option>A</option>
		</Select>,
	);
	expect(page.container.querySelector(".select")).toBeNull();
	expect(page.container.querySelector("svg")).toBeNull();
	expect(page.container.querySelector("select.mine")).not.toBeNull();
});

test("every drop-down of the page is this one: no page or component draws a bare <select>", () => {
	const bare = walk(here).filter(
		(file) =>
			!file.endsWith(join("components", "select.tsx")) &&
			/<select[\s>]/.test(readFileSync(file, "utf8")),
	);
	expect(bare).toEqual([]);
});

test("the drop-down's style sets the native look aside, sizes from the inputs, and keeps a phone from zooming", () => {
	const rule = (selector: string) =>
		SELECT_CSS.slice(SELECT_CSS.indexOf(`${selector} {`)).split("}")[0] ?? "";
	expect(rule(".select > select")).toContain("appearance: none");
	// The box itself comes from the one rule inputs, selects and text areas share.
	const css = readFileSync(join(here, "styles.css"), "utf8");
	expect(css).toMatch(/input,\nselect,\ntextarea \{[^}]*min-height: 2\.5rem/);
	// A pill beside the chips takes their height and shape.
	expect(rule(".select[data-chip] > select")).toContain("min-height: 2rem");
	expect(rule(".select[data-chip] > select")).toContain("radius-full");
	expect(rule(".select[data-chip] > select")).toContain("surface-2");
	// Under a coarse pointer the text is 16px, the size below which iOS Safari zooms in on focus.
	expect(SELECT_CSS).toMatch(
		/@media \(max-width: 719px\), \(pointer: coarse\) \{\s*\.select > select,\s*\.select\[data-chip\] > select \{\s*font-size: 1rem/,
	);
});

test("the style is not in the page's first stylesheet, and the first drop-down shown installs it once", async () => {
	expect(readFileSync(join(here, "styles.css"), "utf8")).not.toContain(
		".select",
	);
	await page.render(
		<>
			<Select aria-label="a">
				<option>A</option>
			</Select>
			<Select aria-label="b">
				<option>A</option>
			</Select>
		</>,
	);
	const adopted = document.adoptedStyleSheets?.length ?? 0;
	const inline = [...document.querySelectorAll("style")].filter((one) =>
		one.textContent?.includes(".select"),
	).length;
	expect(adopted + inline).toBe(1);
});
