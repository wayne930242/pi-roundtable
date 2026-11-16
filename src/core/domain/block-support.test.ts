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

const NOT_DRAWN =
	"Display blocks that ask for input (a form, option buttons or a checklist written as a fenced block in a reply) are not drawn in this chat:";

test("a surface that draws no interactive kind tells the model so, after its own guidance", () => {
	const guided = supportOf(
		{ formatting: "Markdown renders.", blocks: ["table"] },
		"discord:1",
	);
	expect(guided.formatting?.startsWith("Markdown renders. ")).toBe(true);
	expect(guided.formatting).toContain(NOT_DRAWN);
	expect(guided.formatting).toContain("answers by typing");
	// With no guidance of its own the line is all there is, and a bare surface gets it too.
	expect(supportOf({}, "bare:1").formatting).toContain(NOT_DRAWN);
});

test("the line is about blocks written in a reply, and leaves a tool that asks the user alone", () => {
	const none = supportOf({}, "discord:1").formatting;
	const some = supportOf({ blocks: ["options", "suggest"] }, "x:1").formatting;
	for (const formatting of [none, some]) {
		expect(formatting).toContain("blocks written in a reply only");
		expect(formatting).toContain("ask_user");
		// Nothing says the chat has no buttons, or that every question is to be asked in plain text: ask_user posts a card with buttons.
		expect(formatting).not.toContain("cannot show");
		expect(formatting).not.toContain("Ask in plain text.");
	}
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
	expect(formatting).not.toContain(NOT_DRAWN);
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
	expect(host).toContain(NOT_DRAWN);
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
