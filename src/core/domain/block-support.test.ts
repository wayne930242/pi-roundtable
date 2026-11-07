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
	expect(supportOf(surface, "app:agent.a")).toEqual({
		formatting: "Tables render.",
		blocks: ["table"],
		blockText: "plain",
	});
	expect(supportOf(surface, "app:host.1")).toEqual({
		formatting: "Markdown only.",
		blocks: [],
		blockText: "plain",
	});
	expect(supportOf(undefined, "none:1")).toEqual({});
});
