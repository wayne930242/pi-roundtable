import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { oversizedFiles } from "../core/testing/file-size.ts";

test("no file of the command line is over the size limit", () => {
	expect(
		oversizedFiles(resolve(import.meta.dir, "../.."), ["src/cli"]),
	).toEqual([]);
});
