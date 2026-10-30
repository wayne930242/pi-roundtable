import { afterAll, beforeAll, expect, test } from "bun:test";
import { useRef } from "react";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { useFollowEnd } from "./lib/follow-end.ts";

let page: TestPage;
beforeAll(async () => {
	page = await openPage();
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});

function Box(props: { active: boolean; length: number }) {
	const box = useRef<HTMLDivElement>(null);
	useFollowEnd(box, props.active, props.length);
	return (
		<div id="box" ref={box}>
			{"x".repeat(props.length)}
		</div>
	);
}

const box = (): HTMLElement => {
	const found = document.getElementById("box");
	if (!found) throw new Error("no box");
	return found;
};

/** happy-dom lays nothing out: the box is 100px tall and as long as its text, in pixels. */
function lay(element: HTMLElement): void {
	Object.defineProperty(element, "clientHeight", {
		configurable: true,
		value: 100,
	});
	Object.defineProperty(element, "scrollHeight", {
		configurable: true,
		get: () => Math.max(100, element.textContent?.length ?? 0),
	});
}

test("a growing box stays at its newest end while active, until the person scrolls up, and takes it up again when active again", async () => {
	await page.render(<Box active={true} length={150} />);
	lay(box());
	await page.render(<Box active={true} length={300} />);
	expect(box().scrollTop).toBe(300);
	await page.render(<Box active={true} length={400} />);
	expect(box().scrollTop).toBe(400);
	// Scrolled up by hand: it no longer follows.
	await page.act(() => {
		box().scrollTop = 50;
		box().dispatchEvent(new Event("scroll"));
	});
	await page.render(<Box active={true} length={500} />);
	expect(box().scrollTop).toBe(50);
	// Done: the box stays where it is, and the next line follows again from its end.
	await page.render(<Box active={false} length={500} />);
	expect(box().scrollTop).toBe(50);
	await page.render(<Box active={true} length={600} />);
	expect(box().scrollTop).toBe(600);
});

test("a box that is not active is left alone, as a long message that arrived whole is read from its start", async () => {
	await page.render(null);
	await page.render(<Box active={false} length={150} />);
	lay(box());
	await page.render(<Box active={false} length={900} />);
	expect(box().scrollTop).toBe(0);
});
