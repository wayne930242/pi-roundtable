import { expect, test } from "bun:test";
import { navigate } from "./lib/router.ts";
import {
	all,
	brief,
	calls,
	dialogs,
	editorView,
	files,
	holds,
	inEditor,
	page,
	query,
	settle,
	sha,
	show,
	workspacePage,
} from "./workspace-fixture.tsx";

workspacePage();

test("on a desktop the tree stands beside the folder, and the breadcrumbs link to each level", async () => {
	await show("#/workspace/agents%3Asrc%2F");
	// The first root is chosen, its tree is listed and the open folder's rows are shown.
	expect(query(".ws-root-picker > select")).not.toBeNull();
	// The folders on the way to the open place are open in the tree.
	const tree = all(".ws-tree .ws-tree-row a").map((one) => one.textContent);
	expect(tree).toEqual(["data", "src", "main.ts", "util.ts", "README.md"]);
	const crumbs = all(".ws-crumbs a").map((one) => [
		one.textContent,
		one.getAttribute("href"),
	]);
	expect(crumbs).toEqual([
		["Knights' workspace", "#/workspace/agents%3A"],
		["src", "#/workspace/agents%3Asrc%2F"],
	]);
	expect(query(".ws-crumbs a[aria-current='page']")?.textContent).toBe("src");
	expect(all(".ws-row-link").map((one) => one.textContent)).toEqual([
		expect.stringContaining("main.ts"),
		expect.stringContaining("util.ts"),
	]);
	// A file's row links to the file, and the folder's own row to the folder.
	expect(all("a.ws-row-link").map((one) => one.getAttribute("href"))).toEqual([
		"#/workspace/agents%3Asrc%2Fmain.ts",
		"#/workspace/agents%3Asrc%2Futil.ts",
	]);
});

test("a folder in the tree opens when its arrow is pressed, and the choice is remembered per root", async () => {
	await show("#/workspace/agents%3A");
	expect(all(".ws-tree .ws-tree-row a").map((one) => one.textContent)).toEqual([
		"data",
		"src",
		"README.md",
	]);
	const twist = all(".ws-tree .ws-twist")[1] as HTMLElement;
	await page.click(twist);
	await settle();
	expect(all(".ws-tree .ws-tree-row a").map((one) => one.textContent)).toEqual([
		"data",
		"src",
		"main.ts",
		"util.ts",
		"README.md",
	]);
	expect(localStorage.getItem("roundtable.workspace.open.agents")).toBe(
		'["src"]',
	);
});

test("on a phone there is no tree: the roots are listed first, then one folder at a time", async () => {
	await show("#/workspace", 390);
	expect(brief(query(".ws-tree"))).toBeUndefined();
	expect(all(".menu-link").map((one) => one.getAttribute("href"))).toEqual([
		"#/workspace/agents%3A",
		"#/workspace/docs%3A",
	]);
	expect(dialogs()).toBe("");
	window.location.hash = "#/workspace/agents%3Asrc%2F";
	await page.act(async () => {
		window.dispatchEvent(new HashChangeEvent("hashchange"));
	});
	await settle(120);
	expect(brief(query(".ws-tree"))).toBeUndefined();
	expect(
		all(".ws-row-link").map((one) => one.textContent?.includes("main.ts")),
	).toContain(true);
	// The way back goes up one level.
	expect(query("a.icon-button[aria-label='Back']")?.getAttribute("href")).toBe(
		"#/workspace/agents%3A",
	);
});

test("a file opens in read mode with its text highlighted by the editor, which stays read-only until Edit", async () => {
	await show("#/workspace/agents%3Asrc%2Fmain.ts");
	const editor = await editorView();
	expect(editor.state.doc.toString()).toBe("const a = 1;\nconst b = 2;\n");
	expect(editor.state.readOnly).toBe(true);
	// TypeScript was loaded as its own chunk: `const` is a keyword token with a class.
	await settle(150);
	expect(inEditor(".cm-content")?.getAttribute("contenteditable")).toBe(
		"false",
	);
	expect(query(".ws-file-title strong")?.textContent).toBe("main.ts");
	expect(query(".ws-actions button")?.textContent).toBe("Edit");
});

test("the editor lives in a shadow root and adds no <style> to the page, whose Content-Security-Policy would not apply it", async () => {
	await show("#/workspace/agents%3Asrc%2Fmain.ts");
	await editorView();
	const host = query<HTMLElement>(".ws-editor");
	expect(host?.shadowRoot).toBeTruthy();
	// Its rules are adopted as constructed stylesheets (the editor's own, and the host's layout).
	expect(host?.shadowRoot?.adoptedStyleSheets.length).toBeGreaterThanOrEqual(2);
	// Nothing of the editor is in the light DOM, and no <style> element carries its rules.
	expect(brief(host?.querySelector(".cm-editor"))).toBeUndefined();
	expect(host?.shadowRoot?.querySelector(".cm-editor")).toBeTruthy();
	const styles = [...document.querySelectorAll("style")].map(
		(one) => one.textContent ?? "",
	);
	expect(styles.filter((text) => text.includes(".cm-"))).toEqual([]);
});

test("editing marks the title and holds the page: a link to another pane asks first, and Keep editing stays", async () => {
	await show("#/workspace/agents%3AREADME.md");
	const editor = await editorView();
	await page.click(query(".ws-actions button"));
	expect(editor.state.readOnly).toBe(false);
	await page.act(() => {
		editor.dispatch({ changes: { from: 0, insert: "x" } });
	});
	expect(query(".ws-file-title strong")?.textContent).toBe("• README.md");
	// Save is available while the text differs.
	expect(query<HTMLButtonElement>(".ws-actions button")?.disabled).toBe(false);
	await page.act(() => navigate("rooms"));
	await settle(50);
	expect(dialogs()).toContain("Unsaved changes, leave?");
	expect(window.location.hash).toContain("workspace");
	const keep = all("dialog button").find(
		(button) => button.textContent === "Keep editing",
	);
	await page.click(keep ?? null);
	await settle(300);
	expect(window.location.hash).toContain("workspace");
	expect(editor.state.doc.toString()).toBe("x# Hello\n");
});

test("Ctrl+S saves with the hash the file was read with, and the line separator of the file is kept", async () => {
	await show("#/workspace/agents%3Asrc%2Fmain.ts");
	const editor = await editorView();
	await page.click(query(".ws-actions button"));
	await page.act(() => {
		// What Enter inserts: the editor's own line break, which is the file's.
		editor.dispatch({
			changes: { from: 0, insert: `// edited${editor.state.lineBreak}` },
		});
	});
	const content = inEditor<HTMLElement>(".cm-content");
	await page.act(() => {
		content?.dispatchEvent(
			new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }),
		);
	});
	await settle(50);
	const put = calls.find((call) => call.method === "PUT");
	expect(put?.url).toBe("api/workspace/agents/file?path=src%2Fmain.ts");
	expect(put?.body?.baseHash).toBe(sha("const a = 1;\r\nconst b = 2;\r\n"));
	expect(put?.body?.text).toBe("// edited\r\nconst a = 1;\r\nconst b = 2;\r\n");
	// Saved: no mark, and the new text is the base.
	expect(query(".ws-file-title strong")?.textContent).toBe("main.ts");
	expect(files.get("src/main.ts")?.text).toBe(
		"// edited\r\nconst a = 1;\r\nconst b = 2;\r\n",
	);
});

test("Ctrl+S writes nothing in read mode, or in edit mode with nothing changed", async () => {
	await show("#/workspace/agents%3Asrc%2Fmain.ts");
	await editorView();
	const press = async () => {
		await page.act(() => {
			inEditor<HTMLElement>(".cm-content")?.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "s",
					ctrlKey: true,
					bubbles: true,
				}),
			);
		});
		await settle(50);
	};
	await press();
	await page.click(query(".ws-actions button"));
	await press();
	expect(calls.filter((call) => call.method === "PUT")).toEqual([]);
});

test("keys typed while a save is out stay unsaved, and the page still asks before leaving with them", async () => {
	await show("#/workspace/agents%3Asrc%2Fmain.ts");
	const editor = await editorView();
	await page.click(query(".ws-actions button"));
	await page.act(() => {
		editor.dispatch({ changes: { from: 0, insert: "// one\r\n" } });
	});
	let release: () => void = () => undefined;
	holds.save = new Promise<void>((done) => {
		release = done;
	});
	const save = all(".ws-actions button").find(
		(button) => button.textContent === "Save",
	);
	await page.click(save ?? null);
	await page.act(() => {
		editor.dispatch({ changes: { from: 0, insert: "// two\r\n" } });
	});
	await page.act(async () => {
		release();
	});
	await settle(80);
	expect(files.get("src/main.ts")?.text).toBe(
		"// one\r\nconst a = 1;\r\nconst b = 2;\r\n",
	);
	// The editor still differs from what was written, and the title says so.
	expect(query(".ws-file-title")?.textContent).toContain("•");
});

test("after a reload in edit mode the editor still accepts typing, and keeps its wrapping", async () => {
	await show("#/workspace/agents%3AREADME.md");
	const editor = await editorView();
	await page.click(query(".ws-actions button"));
	await page.act(() => {
		editor.dispatch({ changes: { from: 0, insert: "mine " } });
	});
	files.set("README.md", { text: "partner's text\n", mtimeMs: 9 });
	const save = all(".ws-actions button").find(
		(button) => button.textContent === "Save",
	);
	await page.click(save ?? null);
	await settle(50);
	const reload = all("dialog button").find(
		(button) => button.textContent === "Reload (discard my edits)",
	);
	await page.click(reload ?? null);
	await settle(80);
	expect(editor.state.doc.toString()).toBe("partner's text\n");
	expect(editor.state.readOnly).toBe(false);
	expect(inEditor(".cm-content")?.getAttribute("contenteditable")).toBe("true");
});

test("a save that finds the file changed opens the conflict dialog: nothing is written, Reload takes the file as it is", async () => {
	await show("#/workspace/agents%3AREADME.md");
	const editor = await editorView();
	await page.click(query(".ws-actions button"));
	await page.act(() => {
		editor.dispatch({ changes: { from: 0, insert: "mine " } });
	});
	// A partner wrote the file after it was read.
	files.set("README.md", { text: "partner's text\n", mtimeMs: 9 });
	const save = all(".ws-actions button").find(
		(button) => button.textContent === "Save",
	);
	await page.click(save ?? null);
	await settle(50);
	expect(dialogs()).toContain("This file changed while you were editing");
	for (const label of [
		"Copy my text",
		"Reload (discard my edits)",
		"Save mine anyway",
	])
		expect(
			all("dialog button").some((button) => button.textContent === label),
		).toBe(true);
	expect(files.get("README.md")?.text).toBe("partner's text\n");
	const reload = all("dialog button").find(
		(button) => button.textContent === "Reload (discard my edits)",
	);
	await page.click(reload ?? null);
	await settle(80);
	expect(editor.state.doc.toString()).toBe("partner's text\n");
	expect(files.get("README.md")?.text).toBe("partner's text\n");
});

test("Save mine anyway asks a second time, then writes with the hash the conflict named", async () => {
	await show("#/workspace/agents%3AREADME.md");
	const editor = await editorView();
	await page.click(query(".ws-actions button"));
	await page.act(() => {
		editor.dispatch({ changes: { from: 0, insert: "mine " } });
	});
	files.set("README.md", { text: "partner's text\n", mtimeMs: 9 });
	await page.click(
		all(".ws-actions button").find((button) => button.textContent === "Save") ??
			null,
	);
	await settle(50);
	await page.click(
		all("dialog button").find(
			(button) => button.textContent === "Save mine anyway",
		) ?? null,
	);
	await settle(50);
	// Not yet: the second question comes first.
	expect(dialogs()).toContain("Replace the knight's changes?");
	expect(files.get("README.md")?.text).toBe("partner's text\n");
	await page.click(
		all("dialog button")
			.filter((button) => button.textContent === "Save mine anyway")
			.at(-1) ?? null,
	);
	await settle(80);
	const puts = calls.filter((call) => call.method === "PUT");
	expect(puts.at(-1)?.body?.baseHash).toBe(sha("partner's text\n"));
	expect(files.get("README.md")?.text).toBe("mine # Hello\n");
});
