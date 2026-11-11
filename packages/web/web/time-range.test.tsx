import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	HALF_HOURS,
	TimeRange,
	timeOptions,
} from "./components/time-range.tsx";
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

const selects = () => [
	...page.container.querySelectorAll<HTMLSelectElement>("select"),
];
const times = (control: HTMLSelectElement | undefined) =>
	[...(control?.querySelectorAll("option") ?? [])].map((one) => one.value);
const choose = (control: HTMLSelectElement | undefined, value: string) =>
	page.act(() => {
		if (!control) throw new Error("no drop-down");
		Object.getOwnPropertyDescriptor(
			HTMLSelectElement.prototype,
			"value",
		)?.set?.call(control, value);
		control.dispatchEvent(new Event("change", { bubbles: true }));
	});

test("the times offered are the 48 half hours of the day, in order", () => {
	expect(HALF_HOURS).toHaveLength(48);
	expect(HALF_HOURS.slice(0, 4)).toEqual(["00:00", "00:30", "01:00", "01:30"]);
	expect(HALF_HOURS.slice(-2)).toEqual(["23:00", "23:30"]);
	expect(new Set(HALF_HOURS).size).toBe(48);
	expect(
		HALF_HOURS.every((time) => /^([01]\d|2[0-3]):(00|30)$/.test(time)),
	).toBe(true);
	expect(timeOptions("07:30")).toBe(HALF_HOURS);
});

test("a time that is not a half hour is offered as it is, in its place, and no other is added", () => {
	const offered = timeOptions("22:10");
	expect(offered).toHaveLength(49);
	expect(offered.slice(44, 47)).toEqual(["22:00", "22:10", "22:30"]);
	expect(timeOptions("00:05").slice(0, 2)).toEqual(["00:00", "00:05"]);
	expect(timeOptions("23:59").at(-1)).toBe("23:59");
});

test("From and To are two drop-downs named by their words, each showing its time; a change tells both times", async () => {
	const told: { start: string; end: string }[] = [];
	const draw = (start: string, end: string) =>
		page.render(
			<TimeRange
				start={start}
				end={end}
				onChange={(next) => told.push(next)}
			/>,
		);
	await draw("22:10", "07:00");
	const [from, to] = selects();
	expect(selects()).toHaveLength(2);
	expect(from?.closest("label")?.firstChild?.textContent).toBe("From");
	expect(to?.closest("label")?.firstChild?.textContent).toBe("To");
	// Each is the page's drop-down, not the system's time picker.
	expect(from?.parentElement?.classList.contains("select")).toBe(true);
	expect(page.container.querySelector("input")).toBeNull();
	expect([from?.value, to?.value]).toEqual(["22:10", "07:00"]);
	expect(times(from)).toHaveLength(49);
	expect(times(to)).toEqual([...HALF_HOURS]);
	await choose(to, "06:30");
	expect(told).toEqual([{ start: "22:10", end: "06:30" }]);
	// The saved 22:10 is rewritten only when the person picks another time.
	await choose(from, "22:30");
	expect(told[1]).toEqual({ start: "22:30", end: "07:00" });
	await draw("22:30", "07:00");
	expect(times(selects()[0])).toEqual([...HALF_HOURS]);
});

test("the zone stands in the row after the two drop-downs, and is left out when there is none", async () => {
	await page.render(
		<TimeRange
			start="22:00"
			end="07:00"
			zone="Asia/Taipei"
			onChange={() => {}}
		/>,
	);
	const row = page.container.querySelector(".time-range");
	expect([...(row?.children ?? [])].map((one) => one.tagName)).toEqual([
		"LABEL",
		"LABEL",
		"SPAN",
	]);
	expect(row?.querySelector(".time-range-zone")?.textContent).toBe(
		"Asia/Taipei",
	);
	await page.render(
		<TimeRange start="22:00" end="07:00" onChange={() => {}} />,
	);
	expect(page.container.querySelector(".time-range-zone")).toBeNull();
});

test("the range takes every size, tone and variant, which its two drop-downs wear", async () => {
	for (const size of ["sm", "md", "lg"] as const)
		for (const tone of ["default", "danger", "warn", "success"] as const)
			for (const variant of ["outline", "filled"] as const) {
				await page.render(
					<TimeRange
						start="22:00"
						end="07:00"
						zone="UTC"
						size={size}
						tone={tone}
						variant={variant}
						onChange={() => {}}
					/>,
				);
				for (const control of selects())
					expect({
						size: control.getAttribute("data-size") ?? "md",
						tone: control.getAttribute("data-tone") ?? "default",
						variant: control.getAttribute("data-variant") ?? "outline",
					}).toEqual({ size, tone, variant });
				// The row knows the size, for the zone's height.
				expect(
					page.container
						.querySelector(".time-range")
						?.getAttribute("data-size") ?? "md",
				).toBe(size);
			}
});

test("the zone is as tall as a drop-down at every size, so it reads level with the times", () => {
	const height = (selector: string) =>
		/min-height: ([^;]+);/.exec(
			FIELD_CSS.slice(FIELD_CSS.indexOf(`\n${selector} {`)).split("}")[0] ?? "",
		)?.[1];
	expect(height(".time-range-zone")).toBe("2.5rem");
	expect(height('.time-range[data-size="sm"] .time-range-zone')).toBe("2rem");
	expect(height('.time-range[data-size="lg"] .time-range-zone')).toBe("3rem");
	// The row lines its parts up on their feet: the words above a drop-down do not move the zone.
	expect(
		FIELD_CSS.slice(FIELD_CSS.indexOf("\n.time-range {")).split("}")[0],
	).toContain("align-items: flex-end");
	// On a phone a drop-down is a touch target's height, and so is the zone.
	expect(FIELD_CSS).toMatch(
		/@media \(max-width: 719px\), \(pointer: coarse\) \{\s*\.time-range-zone,[^}]*min-height: var\(--touch\)/,
	);
});
