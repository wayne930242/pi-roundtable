import { afterAll, beforeAll, expect, test } from "bun:test";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { characterLookOf, frameOf, initLook, setLook } from "./lib/look.ts";

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
