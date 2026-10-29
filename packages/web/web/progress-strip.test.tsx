import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	LATEST_TOOLS,
	ProgressStrip,
	shownTools,
} from "./components/progress-strip.tsx";
import type { Progress } from "./lib/rooms.ts";

const chips = (n: number): Progress["tools"] =>
	Array.from({ length: n }, (_, i) => ({
		id: `t${i}`,
		tool: `tool${i}`,
		status: "ok" as const,
	})) as Progress["tools"];

test("a folded strip shows only the newest tool calls and counts the rest", () => {
	const tools = chips(18);
	const folded = shownTools(tools, false);
	expect(folded.shown).toEqual(tools.slice(-LATEST_TOOLS));
	expect(folded.hidden).toBe(18 - LATEST_TOOLS);
	expect(shownTools(tools, true)).toEqual({ shown: tools, hidden: 0 });
	expect(shownTools(chips(LATEST_TOOLS), false).hidden).toBe(0);
});

test("a long run renders a fold button and the newest chips, not every call", () => {
	const html = renderToStaticMarkup(
		<ProgressStrip name="Scout" progress={{ text: "", tools: chips(18) }} />,
	);
	expect(html).toContain("chip-more");
	expect(html).toContain('aria-expanded="false"');
	expect(html).toContain("15 earlier tools");
	expect(html).toContain("tool17");
	expect(html).not.toContain(">tool0<");
	expect(html.match(/class="chip" /g)?.length).toBe(LATEST_TOOLS);
});

test("a short run has no fold button", () => {
	const html = renderToStaticMarkup(
		<ProgressStrip name="Scout" progress={{ text: "", tools: chips(2) }} />,
	);
	expect(html).not.toContain("chip-more");
});
