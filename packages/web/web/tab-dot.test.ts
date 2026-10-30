import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { tabTitle } from "./lib/tab-count.ts";
import { startTabDot } from "./lib/tab-dot.ts";

let dom: TestPage;
beforeAll(async () => {
	dom = await openPage();
});
afterAll(async () => {
	await dom.unmount();
	await releaseDom();
});
afterEach(() => {
	document.head.innerHTML = "";
});

function page() {
	document.head.innerHTML =
		'<link rel="icon" href="/app/icons/mark.svg" type="image/svg+xml" sizes="any">' +
		'<link rel="icon" href="/app/icons/192.png" type="image/png">';
	let count = 0;
	let listener = () => {};
	const drawn: string[] = [];
	startTabDot({
		count: () => count,
		subscribe: (next) => {
			listener = next;
		},
		render: async (href) => {
			drawn.push(href);
			return "data:image/png;base64,DOT";
		},
	});
	return {
		drawn,
		set: async (next: number) => {
			count = next;
			listener();
			await new Promise((done) => setTimeout(done, 0));
		},
		hrefs: () =>
			[...document.head.querySelectorAll("link")].map((link) =>
				link.getAttribute("href"),
			),
	};
}

test("the icon takes the dot when anything is unread and its own picture back at zero", async () => {
	const tab = page();
	const plain = tab.hrefs();
	expect(plain).toEqual(["/app/icons/mark.svg", "/app/icons/192.png"]);
	await tab.set(3);
	expect(tab.hrefs()).toEqual([
		"data:image/png;base64,DOT",
		"data:image/png;base64,DOT",
	]);
	expect(tab.drawn).toHaveLength(1);
	expect(tab.drawn[0]).toContain("/app/icons/192.png");
	await tab.set(5);
	expect(tab.drawn).toHaveLength(1);
	await tab.set(0);
	expect(tab.hrefs()).toEqual(plain);
	const [svg] = document.head.querySelectorAll("link");
	expect(svg?.getAttribute("type")).toBe("image/svg+xml");
	expect(svg?.getAttribute("sizes")).toBe("any");
	// A second time uses the picture already drawn.
	await tab.set(1);
	expect(tab.drawn).toHaveLength(1);
	expect(tab.hrefs()[0]).toBe("data:image/png;base64,DOT");
});

test("a count that returns to zero while the dot is still being drawn leaves the icon plain", async () => {
	document.head.innerHTML =
		'<link rel="icon" href="/i/192.png" type="image/png">';
	let count = 1;
	let listener = () => {};
	let release: (url: string) => void = () => {};
	startTabDot({
		count: () => count,
		subscribe: (next) => {
			listener = next;
		},
		render: () => new Promise((done) => (release = done)),
	});
	count = 0;
	listener();
	release("data:image/png;base64,LATE");
	await new Promise((done) => setTimeout(done, 0));
	expect(document.head.querySelector("link")?.getAttribute("href")).toBe(
		"/i/192.png",
	);
});

test("the title leads with the count while anything waits", () => {
	expect(tabTitle("Team", 0)).toBe("Team");
	expect(tabTitle("Team", 3)).toBe("(3) Team");
});
