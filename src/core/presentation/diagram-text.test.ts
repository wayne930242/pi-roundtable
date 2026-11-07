import { expect, test } from "bun:test";
import { DIAGRAM_TEXT_DEADLINE_MS, diagramText } from "./diagram-text.ts";

const slow = `stateDiagram-v2\n${Array.from({ length: 25 }, (_, i) => `S${i} --> S${i + 1}`).join("\n")}`;

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
