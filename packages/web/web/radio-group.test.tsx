import { afterAll, beforeAll, expect, test } from "bun:test";
import { RadioGroup } from "./components/radio-group.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { FIELD_CSS } from "./lib/field-look.ts";

let page: TestPage;
beforeAll(async () => {
	page = await openPage();
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});

const OPTIONS = [
	{ value: "", label: "Automatic" },
	{ value: "session", label: "Sign-in account" },
	{ value: "discord", label: <strong>Discord</strong> },
] as const;
const radios = () => [
	...page.container.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
];

test("each choice is a row with its radio button before its words, in one named group, and the one that holds is checked", async () => {
	await page.render(
		<RadioGroup
			legend="Shown as"
			name="shown-as"
			value="session"
			options={OPTIONS}
			onChange={() => {}}
		/>,
	);
	const group = page.container.querySelector("fieldset.radio-group");
	const legend = group?.querySelector("legend");
	expect(legend?.textContent).toBe("Shown as");
	expect(legend?.className).toBe("visually-hidden");
	const rows = [...(group?.querySelectorAll(":scope > label") ?? [])];
	expect(rows.map((row) => row.textContent)).toEqual([
		"Automatic",
		"Sign-in account",
		"Discord",
	]);
	for (const row of rows)
		expect(row.firstElementChild?.getAttribute("type")).toBe("radio");
	expect(radios().map((one) => one.name)).toEqual([
		"shown-as",
		"shown-as",
		"shown-as",
	]);
	expect(radios().map((one) => one.checked)).toEqual([false, true, false]);
});

test("choosing a row tells its value, and no row is checked while none holds", async () => {
	const told: string[] = [];
	await page.render(
		<RadioGroup
			legend="Shown as"
			name="shown-as"
			value={undefined}
			options={OPTIONS}
			onChange={(value) => told.push(value)}
		/>,
	);
	expect(radios().map((one) => one.checked)).toEqual([false, false, false]);
	await page.click(radios()[2] ?? null);
	await page.click(radios()[0] ?? null);
	expect(told).toEqual(["discord", ""]);
});

test("the group takes every size and tone: its buttons wear both and its rows the size", async () => {
	for (const size of ["sm", "md", "lg"] as const)
		for (const tone of ["default", "danger", "warn", "success"] as const) {
			await page.render(
				<RadioGroup
					legend="Pick"
					name="pick"
					value=""
					size={size}
					tone={tone}
					options={OPTIONS}
					onChange={() => {}}
				/>,
			);
			for (const one of radios())
				expect([
					one.getAttribute("data-size") ?? "md",
					one.getAttribute("data-tone") ?? "default",
				]).toEqual([size, tone]);
			expect(
				page.container
					.querySelector(".radio-group")
					?.getAttribute("data-size") ?? "md",
			).toBe(size);
		}
});

test("the rows touch: a row is its own height and the list adds no gap between rows", () => {
	const body = (selector: string) =>
		FIELD_CSS.slice(FIELD_CSS.indexOf(`\n${selector} {`)).split("}")[0] ?? "";
	expect(body(".radio-group")).toContain("flex-direction: column");
	expect(body(".radio-group")).not.toContain("gap");
	const row = body(".radio-group > label");
	expect(row).toContain("flex-direction: row");
	expect(row).toContain("align-items: center");
	expect(row).toContain("min-height: 2rem");
	// The button sits at the row's edge: the browser's own margin around it is taken off.
	expect(body(".radio-group input")).toContain("margin: 0");
	// On a phone each row is a touch target, at every size.
	expect(FIELD_CSS).toMatch(
		/@media \(max-width: 719px\), \(pointer: coarse\) \{[^}]*\.radio-group > label,\s*\.radio-group\[data-size\] > label \{\s*min-height: var\(--touch\)/,
	);
});
