import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { HostMarkdown } from "./components/host-markdown.tsx";
import { MarkdownDocument } from "./components/markdown.tsx";
import { MarkdownContent } from "./components/message-markdown.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";

let page: TestPage;
const copied: string[] = [];
beforeAll(async () => {
	page = await openPage();
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText: async (text: string) => void copied.push(text) },
	});
});
afterAll(async () => {
	Reflect.deleteProperty(navigator, "clipboard");
	await page.unmount();
	await releaseDom();
});
afterEach(async () => {
	copied.length = 0;
	await page.render(null);
});

const SOURCE = "Run this:\n\n```bash\nbun install\nbun test\n```\n";

// A message, a host room and a skill document draw a fenced block with the same element: one
// code block, whose button copies the code as written.
for (const [where, view] of [
	["a message", <MarkdownContent key="m" source={SOURCE} />],
	["a host room", <HostMarkdown key="h" source={SOURCE} />],
	["a skill document", <MarkdownDocument key="d" source={SOURCE} />],
] as const) {
	test(`a code block in ${where} has a button that copies its code`, async () => {
		await page.render(view);
		const blocks = page.container.querySelectorAll(".code-block");
		expect(blocks.length).toBe(1);
		const button = blocks[0]?.querySelector("button.code-copy") ?? null;
		expect(button?.getAttribute("aria-label")).toBe("Copy");
		await page.click(button);
		expect(copied).toEqual(["bun install\nbun test\n"]);
	});
}
