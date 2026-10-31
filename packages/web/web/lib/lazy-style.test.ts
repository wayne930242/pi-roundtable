import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { installStyle } from "./lazy-style.ts";

afterAll(async () => {
	if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

const count = () =>
	(document.adoptedStyleSheets?.length ?? 0) +
	[...document.querySelectorAll("style")].filter((one) =>
		one.textContent?.includes(".lazy-probe"),
	).length;

test("a style goes in once per document, and a new document takes it again", async () => {
	if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
	GlobalRegistrator.register({ url: "http://localhost/" });
	installStyle("lazy-probe", ".lazy-probe { color: red }");
	installStyle("lazy-probe", ".lazy-probe { color: red }");
	expect(count()).toBe(1);
	// The next test file's page is a new document; the style an earlier one took is not in it.
	await GlobalRegistrator.unregister();
	GlobalRegistrator.register({ url: "http://localhost/" });
	installStyle("lazy-probe", ".lazy-probe { color: red }");
	expect(count()).toBe(1);
});
