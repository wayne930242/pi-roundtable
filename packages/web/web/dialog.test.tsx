import { afterAll, beforeAll, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog } from "./components/dialog.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { SkillDocument } from "./pages/skills.tsx";

let page: TestPage;
beforeAll(async () => {
	page = await openPage();
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});

/** The sheet slides away on a timer before it reports closed. */
const settle = () =>
	page.act(() => new Promise((done) => setTimeout(done, 300)));

test("a dialog is a sheet: a titled header with an icon close button, and a body that scrolls", async () => {
	let closed = 0;
	await page.render(
		<Dialog open title="Edit note" onClose={() => closed++}>
			<p id="inside">Hello</p>
		</Dialog>,
	);
	const dialog = page.container.querySelector("dialog");
	expect(dialog?.classList.contains("sheet")).toBe(true);
	expect(dialog?.classList.contains("wide")).toBe(false);
	expect(dialog?.getAttribute("aria-label")).toBe("Edit note");
	expect(dialog?.querySelector(".sheet-head h2")?.textContent).toBe(
		"Edit note",
	);
	expect(dialog?.querySelector(".sheet-body #inside")?.textContent).toBe(
		"Hello",
	);
	const close = dialog?.querySelector<HTMLButtonElement>(".sheet-head button");
	expect(close?.getAttribute("aria-label")).toBe("Close");
	// An icon, not the word.
	expect(close?.textContent).toBe("");
	expect(close?.querySelector("svg")).not.toBeNull();
	await page.click(close ?? null);
	await settle();
	expect(closed).toBe(1);
});

test("a wide dialog carries the wide size class for a document", async () => {
	await page.render(
		<Dialog open title="code-review" size="wide" onClose={() => undefined}>
			<p>Body</p>
		</Dialog>,
	);
	const dialog = page.container.querySelector("dialog");
	expect(dialog?.classList.contains("sheet")).toBe(true);
	expect(dialog?.classList.contains("wide")).toBe(true);
});

test("the skill document lists the frontmatter as key/value rows and leaves out a name that is the title", () => {
	const html = renderToStaticMarkup(
		<SkillDocument
			title="code-review"
			detail={{
				name: "code-review",
				metadata: [
					{ key: "name", value: "code-review" },
					{ key: "description", value: "Review a change set." },
					{ key: "metadata.version", value: "1.4.0" },
				],
				body: "# Heading\n\nText",
			}}
		/>,
	);
	expect(html).toContain("<dt>description</dt>");
	expect(html).toContain("<dt>metadata.version</dt>");
	expect(html).not.toContain("<dt>name</dt>");
	expect(html).toContain('class="skill-meta"');
	expect(html).toContain("<h1>Heading</h1>");
});

test("a name that differs from the title stays in the list, and a document with no frontmatter has no list", () => {
	const detail = {
		name: "code-review",
		metadata: [{ key: "name", value: "other" }],
		body: "Text",
	};
	expect(
		renderToStaticMarkup(<SkillDocument title="code-review" detail={detail} />),
	).toContain("<dt>name</dt>");
	expect(
		renderToStaticMarkup(
			<SkillDocument
				title="code-review"
				detail={{ ...detail, metadata: [] }}
			/>,
		),
	).not.toContain("skill-meta");
});
