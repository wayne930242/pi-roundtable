import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { oversizedFiles } from "./testing/file-size.ts";

test("no file of the core is over the size limit", () => {
	expect(
		oversizedFiles(resolve(import.meta.dir, "../.."), ["src/core"]),
	).toEqual([]);
});
