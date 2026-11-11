import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import {
	Checkbox,
	ColorField,
	DateField,
	FieldNote,
	Radio,
	TextArea,
	TextField,
} from "./components/fields.tsx";
import { SearchField } from "./components/search-field.tsx";
import { Select } from "./components/select.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import {
	FIELD_CSS,
	type FieldLook,
	type FieldSize,
	type FieldTone,
	type FieldVariant,
} from "./lib/field-look.ts";

let page: TestPage;
beforeAll(async () => {
	page = await openPage();
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});

const here = import.meta.dir;
const SIZES: FieldSize[] = ["sm", "md", "lg"];
const TONES: FieldTone[] = ["default", "danger", "warn", "success"];
const VARIANTS: FieldVariant[] = ["outline", "filled"];

/** The look attributes of an element, a default being no attribute at all. */
const lookOf = (element: Element | null) => ({
	size: element?.getAttribute("data-size") ?? "md",
	tone: element?.getAttribute("data-tone") ?? "default",
	variant: element?.getAttribute("data-variant") ?? "outline",
});

/** How many times the fields' stylesheet is in the page, among the styles other components install. */
const installed = () =>
	[...(document.adoptedStyleSheets ?? [])].filter((sheet) =>
		[...sheet.cssRules].some((one) => one.cssText.includes(".field-note")),
	).length +
	[...document.querySelectorAll("style")].filter((one) =>
		one.textContent?.includes(".field-note"),
	).length;

/** Each component that draws a box, as one control with the look given. */
const BOXES: Record<string, (look: FieldLook) => ReactElement> = {
	TextField: (look) => <TextField aria-label="x" {...look} />,
	TextArea: (look) => <TextArea aria-label="x" {...look} />,
	DateField: (look) => <DateField aria-label="x" {...look} />,
	Select: (look) => (
		<Select aria-label="x" {...look}>
			<option>A</option>
		</Select>
	),
	SearchField: (look) => (
		<SearchField label="x" value="" onChange={() => {}} {...look} />
	),
};

/** Each component the browser draws, which has a size and a tone and no box to fill. */
const MARKS: Record<
	string,
	(look: Pick<FieldLook, "size" | "tone">) => ReactElement
> = {
	Checkbox: (look) => <Checkbox aria-label="x" {...look} />,
	Radio: (look) => <Radio aria-label="x" {...look} />,
	ColorField: (look) => <ColorField aria-label="x" {...look} />,
};

const control = () =>
	page.container.querySelector<HTMLElement>("input, textarea, select");

test("a control with no look set carries no look attribute and installs no stylesheet: it is the page's own", async () => {
	expect(installed()).toBe(0);
	for (const draw of [...Object.values(BOXES), ...Object.values(MARKS)]) {
		await page.render(draw({}));
		const element = control();
		expect(element).not.toBeNull();
		for (const name of ["data-size", "data-tone", "data-variant"])
			expect(element?.hasAttribute(name)).toBe(false);
		// The defaults by name are the same control.
		await page.render(draw({ size: "md", tone: "default" }));
		expect(control()?.outerHTML).toBe(element?.outerHTML);
	}
	await page.render(
		<TextField aria-label="x" size="md" tone="default" variant="outline" />,
	);
	expect(control()?.outerHTML).toBe('<input aria-label="x">');
	expect(installed()).toBe(0);
});

for (const [name, draw] of Object.entries(BOXES))
	test(`${name} takes every size, tone and variant as the attributes the stylesheet reads`, async () => {
		for (const size of SIZES)
			for (const tone of TONES)
				for (const variant of VARIANTS) {
					await page.render(draw({ size, tone, variant }));
					expect(lookOf(control())).toEqual({ size, tone, variant });
				}
		expect(installed()).toBe(1);
	});

for (const [name, draw] of Object.entries(MARKS))
	test(`${name} takes every size and tone`, async () => {
		for (const size of SIZES)
			for (const tone of TONES) {
				await page.render(draw({ size, tone }));
				expect(lookOf(control())).toEqual({ size, tone, variant: "outline" });
			}
		expect(installed()).toBe(1);
	});

test("each component draws its own kind of control and passes the attributes and the ref on", async () => {
	const refs: Record<string, Element | null> = {};
	const keep = (name: string) => (element: Element | null) => {
		if (element) refs[name] = element;
	};
	await page.render(
		<>
			<TextField ref={keep("text")} id="a" name="n" maxLength={5} />
			<TextField type="url" id="u" />
			<TextArea ref={keep("area")} id="b" rows={3} className="prompt-full" />
			<DateField id="c" defaultValue="2026-11-11" />
			<Checkbox ref={keep("tick")} id="d" defaultChecked />
			<Radio id="e" name="one" />
			<ColorField id="f" defaultValue="#336699" />
		</>,
	);
	const by = (id: string) => document.getElementById(id) as HTMLInputElement;
	// One line of text says no type unless the page names one, as the pages' inputs did.
	expect(by("a").tagName).toBe("INPUT");
	expect(by("a").hasAttribute("type")).toBe(false);
	expect([by("a").name, by("a").maxLength]).toEqual(["n", 5]);
	expect(by("u").type).toBe("url");
	expect(by("b").tagName).toBe("TEXTAREA");
	expect(by("b").className).toBe("prompt-full");
	expect(by("b").getAttribute("rows")).toBe("3");
	expect([by("c").type, by("c").value]).toEqual(["date", "2026-11-11"]);
	expect([by("d").type, by("d").checked]).toEqual(["checkbox", true]);
	expect([by("e").type, by("e").name]).toEqual(["radio", "one"]);
	expect([by("f").type, by("f").value]).toEqual(["color", "#336699"]);
	expect(refs.text).toBe(by("a"));
	expect(refs.area).toBe(by("b"));
	expect(refs.tick).toBe(by("d"));
});

test("a control marked invalid is in danger, unless it names a tone", async () => {
	const tone = () => lookOf(control()).tone;
	await page.render(<TextField aria-label="x" aria-invalid />);
	expect(tone()).toBe("danger");
	expect(control()?.getAttribute("aria-invalid")).toBe("true");
	await page.render(<TextField aria-label="x" aria-invalid={false} />);
	expect(tone()).toBe("default");
	await page.render(<TextField aria-label="x" aria-invalid tone="warn" />);
	expect(tone()).toBe("warn");
	await page.render(<TextField aria-label="x" aria-invalid tone="default" />);
	expect(tone()).toBe("default");
	await page.render(<TextArea aria-label="x" aria-invalid="true" />);
	expect(tone()).toBe("danger");
	await page.render(<Checkbox aria-label="x" aria-invalid />);
	expect(tone()).toBe("danger");
	await page.render(
		<Select aria-label="x" aria-invalid>
			<option>A</option>
		</Select>,
	);
	expect(tone()).toBe("danger");
});

test("a drop-down's chip is a variant of its own, and the chip flag still asks for it", async () => {
	const chip = () =>
		page.container.querySelector(".select")?.hasAttribute("data-chip");
	await page.render(
		<Select aria-label="x" variant="chip" size="sm" tone="warn">
			<option>A</option>
		</Select>,
	);
	expect(chip()).toBe(true);
	expect(lookOf(control())).toEqual({
		size: "sm",
		tone: "warn",
		variant: "outline",
	});
	await page.render(
		<Select aria-label="x" chip>
			<option>A</option>
		</Select>,
	);
	expect(chip()).toBe(true);
	await page.render(
		<Select aria-label="x" variant="filled">
			<option>A</option>
		</Select>,
	);
	expect(chip()).toBe(false);
	expect(lookOf(control()).variant).toBe("filled");
	// A list box takes the look too, on the native control it stays.
	await page.render(
		<Select aria-label="x" rows={4} size="lg" tone="success">
			<option>A</option>
		</Select>,
	);
	expect(page.container.querySelector(".select")).toBeNull();
	expect(control()?.getAttribute("size")).toBe("4");
	expect(lookOf(control())).toEqual({
		size: "lg",
		tone: "success",
		variant: "outline",
	});
});

test("a field note takes the tone and the size, names itself by id, and is announced when it is an error", async () => {
	const note = () => page.container.querySelector(".field-note");
	await page.render(<FieldNote id="hint">Up to 12 letters.</FieldNote>);
	expect(note()?.outerHTML).toBe(
		'<p id="hint" class="field-note">Up to 12 letters.</p>',
	);
	for (const size of SIZES)
		for (const tone of TONES) {
			await page.render(
				<FieldNote size={size} tone={tone}>
					Note
				</FieldNote>,
			);
			expect(lookOf(note())).toEqual({ size, tone, variant: "outline" });
			expect(note()?.getAttribute("role")).toBe(
				tone === "danger" ? "alert" : null,
			);
		}
});

/** The body of the rule whose selector list is exactly `selectors`, outside any media query. */
const rule = (...selectors: string[]) => {
	const head = `\n${selectors.join(",\n")} {`;
	const at = FIELD_CSS.indexOf(head);
	if (at < 0) throw new Error(`no rule ${selectors.join(", ")}`);
	return FIELD_CSS.slice(at + head.length).split("}")[0] ?? "";
};
const each = (suffix: string) =>
	["input", "select", "textarea"].map((tag) => `${tag}${suffix}`);

test("one stylesheet maps the sizes, tones and variants onto the page's tokens", () => {
	for (const tone of ["danger", "warn", "success"]) {
		const body = rule(
			...each(`[data-tone="${tone}"]`),
			`.field-note[data-tone="${tone}"]`,
		);
		expect(body).toContain(`--field-tone: var(--${tone});`);
		expect(body).toContain(`--field-soft: var(--${tone}-soft);`);
	}
	// The border, the tick and the focus ring take the tone; so does the note.
	expect(rule(...each("[data-tone]"))).toContain(
		"border-color: var(--field-tone)",
	);
	expect(rule(...each("[data-tone]"))).toContain(
		"accent-color: var(--field-tone)",
	);
	expect(rule(...each("[data-tone]:focus-visible"))).toContain(
		"outline-color: var(--field-tone)",
	);
	expect(rule(".field-note[data-tone]")).toContain("color: var(--field-tone)");
	// A filled box is tinted, by its tone's soft colour when it has one, and has no border of its own.
	const filled = rule(...each('[data-variant="filled"]'));
	expect(filled).toContain("background: var(--surface-2)");
	expect(filled).toContain("border-color: transparent");
	expect(rule(...each('[data-variant="filled"][data-tone]'))).toContain(
		"background: var(--field-soft)",
	);
	// Small is a compact button's height; large is taller than the page's 2.5rem.
	const app = readFileSync(join(here, "app.css"), "utf8");
	expect(app).toMatch(/button\.compact \{\s*min-height: 2rem;/);
	expect(rule(...each('[data-size="sm"]'))).toContain("min-height: 2rem");
	expect(rule(...each('[data-size="lg"]'))).toContain("min-height: 3rem");
	// A tick box and a radio button keep to a square of their size.
	expect(
		rule(
			'input[type="checkbox"][data-size="sm"]',
			'input[type="radio"][data-size="sm"]',
		),
	).toContain("width: 1rem");
	expect(
		rule(
			'input[type="checkbox"][data-size="lg"]',
			'input[type="radio"][data-size="lg"]',
		),
	).toContain("width: 1.35rem");
});

test("a small control is still 16px on a phone, the size below which a phone zooms in on focus", () => {
	expect(rule(...each('[data-size="sm"]'))).toContain(
		"font-size: var(--text-sm)",
	);
	expect(FIELD_CSS).toMatch(
		/@media \(max-width: 719px\), \(pointer: coarse\) \{\s*input\[data-size="sm"\],\s*select\[data-size="sm"\],\s*textarea\[data-size="sm"\] \{\s*font-size: 1rem;/,
	);
});

test("the looks are not in the stylesheets the page loads first", () => {
	for (const sheet of ["styles.css", "app.css", "tokens.css"]) {
		const css = readFileSync(join(here, sheet), "utf8");
		expect(css).not.toContain("data-size");
		expect(css).not.toContain("field-note");
		expect(css).not.toContain("--field-tone");
	}
});
