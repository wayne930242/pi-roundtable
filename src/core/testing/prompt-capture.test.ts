import { expect, test } from "bun:test";
import { normalize } from "./prompt-capture.ts";

test("a shared temporary root is replaced only where it starts a path, so prose naming it stays", () => {
	const prompt =
		"Write under /tmp/roundtable-scratch, not elsewhere in /tmp. The workspace is /tmp/capture-1.";
	expect(normalize({ prompt }, ["/tmp/capture-1"], ["/tmp"])).toEqual({
		prompt:
			"Write under <tmp>/roundtable-scratch, not elsewhere in /tmp. The workspace is <tmp>.",
	});
});
