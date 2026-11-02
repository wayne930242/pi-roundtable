import { afterAll, beforeAll, expect, test } from "bun:test";
import { COMPOSER_MAX_HEIGHT, Composer } from "./components/composer.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";

let page: TestPage;
beforeAll(async () => {
	page = await openPage();
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});

const area = () => {
	const found =
		page.container.querySelector<HTMLTextAreaElement>(".composer textarea");
	if (!found) throw new Error("no message box");
	return found;
};

/** happy-dom lays nothing out: the box's text is as many pixels tall as it has characters. */
function lay(element: HTMLTextAreaElement): void {
	Object.defineProperty(element, "scrollHeight", {
		configurable: true,
		get: () => Math.max(46, element.value.length),
	});
}

const type = (text: string) =>
	page.act(async () => {
		const element = area();
		Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)?.set?.call(element, text);
		element.dispatchEvent(new Event("input", { bubbles: true }));
		await new Promise<void>((resolve) => setTimeout(resolve, 30));
	});

test("the message box grows with its text without a scrollbar, and scrolls only past its tallest", async () => {
	await page.render(
		<Composer
			draftKey="app:agent.height"
			name="Room"
			limits={undefined}
			stoppable={false}
			onSend={() => undefined}
			onStop={() => undefined}
		/>,
	);
	lay(area());
	// one line: a box set to its whole-pixel scrollHeight can be a fraction short of its text, so it
	// must not scroll, or a desktop browser draws a scrollbar beside one line
	await type("one line");
	expect(area().style.height).toBe("46px");
	expect(area().style.overflowY).toBe("hidden");
	await type("x".repeat(150));
	expect(area().style.height).toBe("150px");
	expect(area().style.overflowY).toBe("hidden");
	// past the cap the box stops growing and scrolls
	await type("x".repeat(COMPOSER_MAX_HEIGHT + 50));
	expect(area().style.height).toBe(`${COMPOSER_MAX_HEIGHT}px`);
	expect(area().style.overflowY).toBe("auto");
	// and shrinks back without one
	await type("short");
	expect(area().style.height).toBe("46px");
	expect(area().style.overflowY).toBe("hidden");
});
