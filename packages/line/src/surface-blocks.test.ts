import { expect, test } from "bun:test";
import { chunksFor } from "pi-roundtable/kit";
import type { LineOutbox } from "./outbox.ts";
import { LineSurface } from "./surface.ts";

test("a reply with display blocks reaches LINE as plain text, with no fence or Markdown markup", () => {
	// Only the surface's declared text flavor matters here, not its outbox.
	const surface = new LineSurface({} as LineOutbox);
	const reply = [
		"> [!WARNING] Heads up\n> This **overwrites** the cache.",
		"```cards\n- {title: Speed, body: 2x faster}\n```",
		"```table\ncolumns: [name, size]\nrows:\n  - [alpha, 1204]\n```",
		"```mermaid\ngraph TD\n  A[Start] --> B[Done]\n```",
		"```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n```",
	].join("\n\n");
	const text = chunksFor(surface, reply).join("\n");
	expect(surface.blockText).toBe("line");
	expect(text).toContain("Heads up");
	expect(text).toContain("alpha");
	expect(text).not.toContain("```");
	expect(text).not.toContain("**");
});
