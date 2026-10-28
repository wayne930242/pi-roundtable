import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CATALOG, type CharacterSpec } from "pi-roundtable/characters";
import { Character } from "./components/character.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { loadKit } from "./lib/kit.ts";

const knight: CharacterSpec = {
	v: 1,
	class: "knight",
	...CATALOG.classes.knight.preset,
};

let page: TestPage;
beforeAll(async () => {
	await loadKit();
	page = await openPage();
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});

test("a valid spec renders one svg.av inside .av-host with the state on it", async () => {
	await page.render(
		<Character
			spec={knight}
			look="modern-light"
			state="working"
			label="Scout"
		/>,
	);
	const host = page.container.querySelector(".av-host");
	expect(host?.getAttribute("data-state")).toBe("working");
	expect(host?.getAttribute("role")).toBe("img");
	expect(host?.getAttribute("aria-label")).toBe("Scout");
	expect(page.container.querySelectorAll("svg.av")).toHaveLength(1);
	expect(host?.querySelector("svg.av")?.parentElement === host).toBe(true);
	// The live drawing carries every overlay, which the stylesheet shows by state.
	expect(page.container.querySelectorAll(".ov").length).toBeGreaterThan(3);
});

test("the expression follows the state unless one is given", async () => {
	await page.render(
		<Character spec={knight} look="modern-light" state="thinking" />,
	);
	expect(
		page.container.querySelector("svg.av")?.getAttribute("data-expr"),
	).toBe("thinking");
	await page.render(
		<Character
			spec={knight}
			look="modern-light"
			state="thinking"
			expr="proud"
		/>,
	);
	expect(
		page.container.querySelector("svg.av")?.getAttribute("data-expr"),
	).toBe("proud");
});

test("a spec from the API with markup in a color renders the suggestion, never an event attribute", async () => {
	const hostile = {
		...knight,
		colors: { ...knight.colors, primary: '#fff" onload="x' },
	} as unknown as CharacterSpec;
	const warned: unknown[] = [];
	const warn = console.warn;
	console.warn = (...args: unknown[]) => warned.push(args);
	try {
		await page.render(
			<Character spec={hostile} look="modern-light" name="Scout" />,
		);
	} finally {
		console.warn = warn;
	}
	expect(page.container.querySelectorAll("svg.av")).toHaveLength(1);
	expect(page.container.innerHTML).not.toContain("onload");
	for (const element of page.container.querySelectorAll("*"))
		for (const attribute of element.getAttributeNames())
			expect(attribute.startsWith("on")).toBe(false);
	// The refusal is logged, not shown.
	expect(warned.length).toBeGreaterThan(0);
});

test("a missing spec renders the suggestion for the name", async () => {
	await page.render(
		<Character spec={undefined} look="modern-light" name="Reviewer of code" />,
	);
	expect(page.container.querySelectorAll("svg.av")).toHaveLength(1);
});

test("two instances on one page have distinct clipPath ids", async () => {
	await page.render(
		<>
			<Character spec={knight} look="modern-light" />
			<Character spec={knight} look="modern-light" />
			<Character spec={knight} look="camelot-dark" frame="shield" />
		</>,
	);
	const ids = [...page.container.querySelectorAll("clipPath")].map((one) =>
		one.getAttribute("id"),
	);
	expect(ids).toHaveLength(3);
	expect(new Set(ids).size).toBe(3);
	// And each svg refers to its own.
	for (const svg of page.container.querySelectorAll("svg.av")) {
		const id = svg.querySelector("clipPath")?.getAttribute("id");
		expect(svg.innerHTML).toContain(`url(#${id})`);
	}
});

test("a character that is not live is marked static, and size goes on through the style", async () => {
	await page.render(
		<Character spec={knight} look="modern-light" live={false} size={44} />,
	);
	const host = page.container.querySelector<HTMLElement>(".av-host");
	expect(host?.classList.contains("static")).toBe(true);
	expect(host?.style.width).toBe("44px");
	expect(host?.getAttribute("style")).not.toContain("transform-origin");
	// Without a label it is decoration beside a name.
	expect(host?.getAttribute("aria-hidden")).toBe("true");
	expect(host?.getAttribute("role")).toBeNull();
});

test("the character component is the only place that injects HTML", () => {
	const root = join(import.meta.dir);
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
				if (
					/dangerouslySetInnerHTML|innerHTML\s*=|insertAdjacentHTML/.test(
						readFileSync(path, "utf8"),
					)
				)
					found.push(path.slice(root.length + 1));
		}
	};
	walk(root);
	expect(found).toEqual(["components/character.tsx"]);
});
