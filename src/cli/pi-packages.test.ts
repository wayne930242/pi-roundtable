import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { piPackagePorts } from "./pi-packages.ts";

const ROOT = resolve(import.meta.dir, "../..");

test("the tools of an installed Pi package are read by loading its extensions", async () => {
	const tools = await piPackagePorts.tools(ROOT, "pi-web-access");
	expect(tools).toContain("web_search");
	expect(tools).toContain("fetch_content");
});

test("a library with no Pi extensions is refused, not loaded as one", async () => {
	await expect(piPackagePorts.tools(ROOT, "pino")).rejects.toThrow(
		"pino is not a Pi package",
	);
});
