import { afterAll, beforeAll, expect, test } from "bun:test";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { characterLookOf, frameOf, initLook, setLook } from "./lib/look.ts";
import { setTheme } from "./lib/theme.ts";

let page: TestPage;
beforeAll(async () => {
	page = await openPage();
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});

const attribute = () => document.documentElement.dataset.look;

test("the host's look goes on the page as data-look, and modern is the default", () => {
	localStorage.clear();
	initLook(undefined);
	expect(attribute()).toBe("modern");
	initLook("camelot");
	expect(attribute()).toBe("camelot");
});

test("a device's own pick wins over the host's, and picking nothing goes back to it", () => {
	localStorage.clear();
	initLook("camelot");
	setLook("modern");
	expect(attribute()).toBe("modern");
	expect(localStorage.getItem("rt-look")).toBe("modern");
	// A later start reads the pick again, whatever the host says.
	initLook("camelot");
	expect(attribute()).toBe("modern");
	setLook(undefined);
	expect(localStorage.getItem("rt-look")).toBeNull();
	expect(attribute()).toBe("camelot");
});

test("the character look is the page look with the scheme, and Camelot draws the shield frame", () => {
	expect(characterLookOf("modern", "light")).toBe("modern-light");
	expect(characterLookOf("camelot", "dark")).toBe("camelot-dark");
	expect(frameOf("camelot")).toBe("shield");
	expect(frameOf("modern")).toBe("disc");
});

test("changing the look or the scheme repaints the toolbar colour tags", async () => {
	localStorage.clear();
	document.head.innerHTML =
		'<meta name="theme-color" content="#f5f6f8" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0f1115" media="(prefers-color-scheme: dark)">';
	const colours = () =>
		[...document.querySelectorAll('meta[name="theme-color"]')].map((meta) =>
			meta.getAttribute("content"),
		);
	const frame = () => new Promise((done) => requestAnimationFrame(done));
	setTheme("light");
	initLook("camelot");
	await frame();
	expect(colours()).toEqual(["#f4ead5", "#f4ead5"]);
	setTheme("dark");
	await frame();
	expect(colours()).toEqual(["#0f1726", "#0f1726"]);
	setLook("modern");
	await frame();
	expect(colours()).toEqual(["#0f1115", "#0f1115"]);
	// Following the system, each tag keeps its own scheme's colour under the look.
	setTheme("system");
	setLook("camelot");
	await frame();
	expect(colours()).toEqual(["#f4ead5", "#0f1726"]);
});
