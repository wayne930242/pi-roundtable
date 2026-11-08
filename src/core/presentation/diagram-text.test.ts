import { expect, setSystemTime, test } from "bun:test";
import {
	DIAGRAM_TEXT_DEADLINE_MS,
	type DrawerSeams,
	diagramDrawer,
	diagramText,
} from "./diagram-text.ts";

// Not the source of reply-chunks.test.ts, which would be remembered from there.
const slow = `stateDiagram-v2\n${Array.from({ length: 26 }, (_, i) => `S${i} --> S${i + 1}`).join("\n")}`;

/** A clock and a drawing that costs `cost(source, waitMs)` ms of it, so no test waits on real time. */
function stubbed(
	answer: (
		source: string,
		waitMs: number,
	) => ReturnType<NonNullable<DrawerSeams["draw"]>>,
	cost: (waitMs: number) => number,
) {
	let clock = 0;
	const asked: string[] = [];
	const seams: DrawerSeams = {
		now: () => clock,
		draw: (source, waitMs) => {
			asked.push(source);
			clock += cost(waitMs);
			return answer(source, waitMs);
		},
	};
	return { seams, asked };
}

test("draws a small diagram as boxes", () => {
	expect(diagramText("graph TD\n  A[Start] --> B[Done]")).toContain("Start");
});

test("a real worker gives up on a drawing past the deadline", () => {
	const first = performance.now();
	expect(diagramText(slow)).toBeUndefined();
	expect(performance.now() - first).toBeGreaterThanOrEqual(
		DIAGRAM_TEXT_DEADLINE_MS - 50,
	);
});

test("gives up on a drawing past the deadline, once: the same source is then answered from memory", () => {
	const { seams, asked } = stubbed(
		() => "slow",
		(waitMs) => waitMs,
	);
	const source = `${slow}\nM1 --> M2`;
	expect(diagramDrawer(seams)(source)).toBeUndefined();
	expect(diagramDrawer(seams)(source)).toBeUndefined();
	expect(asked).toEqual([source]);
});

test("draws the next diagram after a worker was dropped for a slow one", () => {
	expect(diagramText(slow)).toBeUndefined();
	// The restart counts against the reply's budget, so a loaded host may leave the first try as source.
	const drawn = Array.from({ length: 10 }, (_, n) =>
		diagramText(`graph LR\n  X${n}[One${n}] --> Y${n}[Two]`),
	);
	expect(drawn.find((text) => text !== undefined)).toContain("One");
});

test("does not draw a source over 3 KB, and does not draw what is not a diagram", () => {
	expect(diagramText(`graph TD\n${"  A --> B\n".repeat(400)}`)).toBeUndefined();
	expect(diagramText("not a diagram")).toBeUndefined();
});

test("a reply of many slow charts holds the host for about one deadline, not one per chart", () => {
	const { seams, asked } = stubbed(
		() => "slow",
		(waitMs) => waitMs,
	);
	const draw = diagramDrawer(seams);
	const charts = Array.from(
		{ length: 10 },
		(_, n) => `graph LR\n  Slow${n} --> E`,
	);
	for (const chart of charts) expect(draw(chart)).toBeUndefined();
	// The first chart used the whole deadline; the others were not tried.
	expect(asked).toEqual([charts[0] as string]);
});

test("a reply draws at most three charts afresh, and the budget cuts it shorter", () => {
	const quick = Array.from(
		{ length: 5 },
		(_, n) => `graph LR\n  Z${n}[Quick${n}] --> W${n}[End]`,
	);
	const cheap = stubbed(
		(source) => ({ text: `drawn ${source}` }),
		() => 100,
	);
	const draw = diagramDrawer(cheap.seams);
	expect(quick.map((q) => draw(q)).filter((t) => t !== undefined)).toHaveLength(
		3,
	);
	const dear = stubbed(
		(source) => ({ text: `drawn ${source}` }),
		() => 300,
	);
	const costly = diagramDrawer(dear.seams);
	const other = quick.map((q) => q.replace("Z", "Y"));
	expect(
		other.map((q) => costly(q)).filter((t) => t !== undefined),
	).toHaveLength(2);
});

test("a chart left undrawn for the reply's budget is drawn in a later reply", () => {
	const quick = Array.from(
		{ length: 5 },
		(_, n) => `graph LR\n  V${n}[Late${n}] --> U${n}[End]`,
	);
	const { seams, asked } = stubbed(
		(source) => ({ text: `drawn ${source}` }),
		() => 100,
	);
	const first = diagramDrawer(seams);
	for (const q of quick) first(q);
	expect(asked).toEqual(quick.slice(0, 3));
	expect(diagramDrawer(seams)(quick[4] as string)).toContain("Late4");
	expect(asked).toEqual([...quick.slice(0, 3), quick[4] as string]);
});

test("a source that overran is tried again after a while", () => {
	const source = `${slow}\nS90 --> S91`;
	const { seams, asked } = stubbed(
		() => "slow",
		(waitMs) => waitMs,
	);
	try {
		setSystemTime(new Date("2026-01-01T00:00:00Z"));
		expect(diagramDrawer(seams)(source)).toBeUndefined();
		expect(diagramDrawer(seams)(source)).toBeUndefined();
		expect(asked).toEqual([source]);
		setSystemTime(new Date("2026-01-01T00:11:00Z"));
		expect(diagramDrawer(seams)(source)).toBeUndefined();
		expect(asked).toEqual([source, source]);
	} finally {
		setSystemTime();
	}
});
