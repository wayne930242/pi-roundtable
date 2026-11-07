import { expect, setSystemTime, test } from "bun:test";
import {
	DIAGRAM_TEXT_DEADLINE_MS,
	diagramDrawer,
	diagramText,
} from "./diagram-text.ts";

// Not the source of reply-chunks.test.ts, which would be remembered from there.
const slow = `stateDiagram-v2\n${Array.from({ length: 26 }, (_, i) => `S${i} --> S${i + 1}`).join("\n")}`;

test("draws a small diagram as boxes", () => {
	expect(diagramText("graph TD\n  A[Start] --> B[Done]")).toContain("Start");
});

test("gives up on a drawing past the deadline, once: the same source is then answered from memory", () => {
	const first = performance.now();
	expect(diagramText(slow)).toBeUndefined();
	const spent = performance.now() - first;
	expect(spent).toBeGreaterThanOrEqual(DIAGRAM_TEXT_DEADLINE_MS - 50);
	expect(spent).toBeLessThan(DIAGRAM_TEXT_DEADLINE_MS + 2000);
	const again = performance.now();
	expect(diagramText(slow)).toBeUndefined();
	expect(performance.now() - again).toBeLessThan(20);
});

test("draws the next diagram after a worker was dropped for a slow one", () => {
	expect(diagramText(slow)).toBeUndefined();
	expect(diagramText("graph LR\n  X[One] --> Y[Two]")).toContain("One");
});

test("does not draw a source over 3 KB, and does not draw what is not a diagram", () => {
	expect(diagramText(`graph TD\n${"  A --> B\n".repeat(400)}`)).toBeUndefined();
	expect(diagramText("not a diagram")).toBeUndefined();
});

test("a reply of many slow charts holds the host for about one deadline, not one per chart", () => {
	const charts = Array.from(
		{ length: 10 },
		(_, n) =>
			`stateDiagram-v2\n${Array.from({ length: 27 + n }, (_, i) => `Q${n}x${i} --> Q${n}x${i + 1}`).join("\n")}`,
	);
	const draw = diagramDrawer();
	const first = performance.now();
	for (const chart of charts) expect(draw(chart)).toBeUndefined();
	expect(performance.now() - first).toBeLessThan(1500);
});

test("a chart left undrawn for the reply's budget is drawn in a later reply", () => {
	const draw = diagramDrawer();
	const quick = Array.from(
		{ length: 5 },
		(_, n) => `graph LR\n  Z${n}[Quick${n}] --> W${n}[End]`,
	);
	const texts = quick.map((q) => draw(q));
	expect(texts.filter((t) => t !== undefined).length).toBe(3);
	expect(diagramText(quick[4] as string)).toContain("Quick4");
});

test("a source that overran is tried again after a while", () => {
	const source = `${slow}\nS90 --> S91`;
	try {
		setSystemTime(new Date("2026-01-01T00:00:00Z"));
		expect(diagramText(source)).toBeUndefined();
		const kept = performance.now();
		expect(diagramText(source)).toBeUndefined();
		expect(performance.now() - kept).toBeLessThan(20);
		setSystemTime(new Date("2026-01-01T00:11:00Z"));
		const retried = performance.now();
		expect(diagramText(source)).toBeUndefined();
		expect(performance.now() - retried).toBeGreaterThanOrEqual(
			DIAGRAM_TEXT_DEADLINE_MS - 50,
		);
	} finally {
		setSystemTime();
	}
});
