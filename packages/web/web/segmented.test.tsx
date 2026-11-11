import { afterAll, beforeAll, expect, test } from "bun:test";
import { Segmented } from "./components/segmented.tsx";
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
	{ value: "slim", label: "Slim" },
	{ value: "regular", label: <strong>Regular</strong>, title: "Middle" },
	{ value: "stout", label: "Stout" },
] as const;
const radios = () => [
	...page.container.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
];
const bar = () => page.container.querySelector("fieldset.segmented");

test("one named group of native radio buttons under a hidden legend, the held choice checked and marked", async () => {
	await page.render(
		<Segmented
			legend="Build"
			name="build"
			value="regular"
			options={OPTIONS}
			onChange={() => {}}
		/>,
	);
	const legend = bar()?.querySelector("legend");
	expect(legend?.textContent).toBe("Build");
	expect(legend?.className).toBe("visually-hidden");
	// One name and native radio buttons: the arrow keys move within the group, with no handler of ours.
	expect(radios().map((one) => one.name)).toEqual(["build", "build", "build"]);
	expect(radios().map((one) => one.value)).toEqual([
		"slim",
		"regular",
		"stout",
	]);
	expect(radios().map((one) => one.checked)).toEqual([false, true, false]);
	const labels = [...(bar()?.querySelectorAll(":scope > label") ?? [])];
	expect(labels.map((one) => one.getAttribute("data-checked"))).toEqual([
		"false",
		"true",
		"false",
	]);
	expect(labels[1]?.getAttribute("title")).toBe("Middle");
});

test("choosing a choice tells its value and the change event", async () => {
	const told: string[] = [];
	await page.render(
		<Segmented
			legend="Build"
			name="build"
			value={undefined}
			options={OPTIONS}
			onChange={(value, event) => told.push(`${value}:${event.target.type}`)}
		/>,
	);
	await page.click(radios()[2] ?? null);
	await page.click(radios()[0] ?? null);
	expect(told).toEqual(["stout:radio", "slim:radio"]);
});

test("size and tone are attributes of the bar, and a default carries none", async () => {
	await page.render(
		<Segmented
			legend="b"
			name="b"
			value="slim"
			options={OPTIONS}
			onChange={() => {}}
		/>,
	);
	for (const name of ["data-size", "data-tone", "data-wide"])
		expect(bar()?.hasAttribute(name)).toBe(false);
	for (const size of ["sm", "lg"] as const)
		for (const tone of ["danger", "warn", "success"] as const) {
			await page.render(
				<Segmented
					legend="b"
					name="b"
					value="slim"
					size={size}
					tone={tone}
					options={OPTIONS}
					onChange={() => {}}
				/>,
			);
			expect(bar()?.getAttribute("data-size")).toBe(size);
			expect(bar()?.getAttribute("data-tone")).toBe(tone);
			// The radio buttons are hidden under the labels: the look stays on the bar.
			expect(radios()[0]?.hasAttribute("data-size")).toBe(false);
		}
	expect(FIELD_CSS).toContain('.segmented[data-size="sm"] label');
	expect(FIELD_CSS).toContain('.segmented[data-tone="danger"]');
});

test("wide fills the row, and a caller's class joins the bar's own", async () => {
	await page.render(
		<Segmented
			wide
			className="table-mode"
			legend="b"
			name="b"
			value="slim"
			options={OPTIONS}
			onChange={() => {}}
		/>,
	);
	expect(bar()?.hasAttribute("data-wide")).toBe(true);
	expect(bar()?.className).toBe("segmented table-mode");
});
