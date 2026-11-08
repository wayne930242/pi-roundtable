import { expect, test } from "bun:test";
import { supportOf } from "./block-support.ts";

test("a surface's support is its own unless it says a channel differs", () => {
	const surface = {
		formatting: "Tables render.",
		blocks: ["table"] as const,
		blockText: "plain" as const,
		support: (channel: string) =>
			channel === "app:host.1"
				? { formatting: "Markdown only.", blocks: [] }
				: undefined,
	};
	const own = supportOf(surface, "app:agent.a");
	expect(own).toMatchObject({ blocks: ["table"], blockText: "plain" });
	expect(own.formatting?.startsWith("Tables render. ")).toBe(true);
	const host = supportOf(surface, "app:host.1");
	expect(host).toMatchObject({ blocks: [], blockText: "plain" });
	expect(host.formatting?.startsWith("Markdown only. ")).toBe(true);
	expect(supportOf(undefined, "none:1")).toEqual({});
});

const CANNOT = "This chat cannot show forms, option buttons or checklists.";

test("a surface that draws no interactive kind tells the model so, after its own guidance", () => {
	const guided = supportOf(
		{ formatting: "Markdown renders.", blocks: ["table"] },
		"discord:1",
	);
	expect(guided.formatting?.startsWith("Markdown renders. ")).toBe(true);
	expect(guided.formatting).toContain(CANNOT);
	expect(guided.formatting).toContain("answers by typing");
	// With no guidance of its own the line is all there is, and a bare surface gets it too.
	expect(supportOf({}, "bare:1").formatting).toContain(CANNOT);
});

test("a surface that draws every interactive kind says nothing about them", () => {
	const all = ["options", "suggest", "form", "checklist", "review"] as const;
	const support = supportOf(
		{ formatting: "Tables render.", blocks: [...all, "table"] },
		"app:agent.a",
	);
	expect(support.formatting).toBe("Tables render.");
});

test("a surface that draws only some interactive kinds names the ones it cannot", () => {
	const { formatting } = supportOf({ blocks: ["options", "suggest"] }, "x:1");
	expect(formatting).not.toContain(CANNOT);
	expect(formatting).toContain("form");
	expect(formatting).toContain("checklist");
	expect(formatting).toContain("review");
	expect(formatting).not.toContain("options");
});

test("a channel that draws no blocks gets the line even when its surface draws them", () => {
	const surface = {
		formatting: "Tables render.",
		blocks: ["options", "suggest", "form", "checklist", "review"] as const,
		support: (channel: string) =>
			channel === "app:host.1"
				? { formatting: "Markdown only.", blocks: [] }
				: undefined,
	};
	expect(supportOf(surface, "app:agent.a").formatting).toBe("Tables render.");
	const host = supportOf(surface, "app:host.1").formatting;
	expect(host?.startsWith("Markdown only. ")).toBe(true);
	expect(host).toContain(CANNOT);
});

test("a surface whose own guidance covers blocks opts out of the line", () => {
	const support = supportOf(
		{ formatting: "No forms here, ask in words.", blockNote: false },
		"x:1",
	);
	expect(support.formatting).toBe("No forms here, ask in words.");
});

test("the text language of a block is the surface's own, else the one the host gives", () => {
	expect(supportOf({ blocks: [] }, "x:1").lang).toBeUndefined();
	expect(supportOf({ blocks: [] }, "x:1", "zh-TW").lang).toBe("zh-TW");
	expect(supportOf({ blocks: [], lang: "en" }, "x:1", "zh-TW").lang).toBe("en");
});
