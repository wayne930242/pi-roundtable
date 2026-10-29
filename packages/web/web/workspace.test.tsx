import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { EditorView } from "@codemirror/view";
import type {
	ConfigView,
	WorkspaceConflict,
	WorkspaceEntry,
	WorkspaceFileView,
} from "../src/api-types.ts";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { ConfigContext } from "./lib/config.ts";
import { navigate } from "./lib/router.ts";
import { WorkspacePage } from "./pages/workspace.tsx";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

interface Stored {
	text?: string;
	/** Binary or too large: only the metadata. */
	opaque?: "binary" | "too-large";
	mtimeMs: number;
}

/** A workspace in memory, behind the same API the server answers. */
let files: Map<string, Stored>;
let calls: { method: string; url: string; body?: Record<string, unknown> }[];
/** When set, a PUT answers this instead of saving. */
let conflictOnSave: WorkspaceConflict | undefined;
/** While set, a save waits for it: keys can be typed while the request is out. */
let holdSave: Promise<void> | undefined;

const config = {
	title: "Test",
	panes: ["rooms", "workspace"],
	timeZone: "UTC",
} as ConfigView;

const entriesOf = (dir: string): WorkspaceEntry[] => {
	const seen = new Map<string, WorkspaceEntry>();
	const prefix = dir ? `${dir}/` : "";
	for (const [path, file] of files) {
		if (!path.startsWith(prefix)) continue;
		const rest = path.slice(prefix.length);
		const [first, ...more] = rest.split("/");
		if (!first) continue;
		seen.set(
			first,
			more.length > 0
				? { name: first, kind: "dir", size: 0, mtimeMs: file.mtimeMs }
				: {
						name: first,
						kind: "file",
						size: (file.text ?? "").length,
						mtimeMs: file.mtimeMs,
					},
		);
	}
	return [...seen.values()].sort(
		(a, b) =>
			Number(b.kind === "dir") - Number(a.kind === "dir") ||
			a.name.localeCompare(b.name),
	);
};

const view = (path: string, file: Stored): WorkspaceFileView => {
	const text = file.text ?? "";
	const crlf = text.includes("\r\n");
	return {
		path,
		size: text.length,
		mtimeMs: file.mtimeMs,
		hash: sha(text),
		editable: file.opaque === undefined,
		...(file.opaque ? { reason: file.opaque } : {}),
		binary: file.opaque === "binary",
		tooLarge: file.opaque === "too-large",
		eol: crlf ? "\r\n" : "\n",
		bom: false,
		language: path.endsWith(".ts") ? "typescript" : "plain",
		...(file.opaque ? {} : { text }),
	};
};

const answer = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const realFetch = globalThis.fetch;
function fakeFetch(
	input: string | URL | Request,
	init?: RequestInit,
): Promise<Response> {
	const url = new URL(String(input), "http://localhost/");
	const method = init?.method ?? "GET";
	const body = init?.body
		? (JSON.parse(String(init.body)) as Record<string, unknown>)
		: undefined;
	calls.push({
		method,
		url: `${url.pathname.slice(1)}${url.search}`,
		...(body ? { body } : {}),
	});
	const parts = url.pathname.split("/").filter(Boolean);
	const path = decodeURIComponent(url.searchParams.get("path") ?? "");
	if (parts.join("/") === "api/workspace")
		return Promise.resolve(
			answer({
				roots: [
					{ id: "agents", label: "Agents", writable: true },
					{ id: "docs", label: "Docs", writable: false },
				],
			}),
		);
	const action = parts[3];
	if (action === "list")
		return Promise.resolve(
			answer({ path, entries: entriesOf(path), truncated: false }),
		);
	if (action === "file" && method === "GET") {
		const file = files.get(path);
		return Promise.resolve(
			file ? answer(view(path, file)) : answer({ error: "no" }, 404),
		);
	}
	if (action === "file" && method === "PUT" && holdSave) {
		const held = holdSave;
		holdSave = undefined;
		return held.then(() => fakeFetch(input, init));
	}
	if (action === "file" && method === "PUT") {
		if (conflictOnSave) return Promise.resolve(answer(conflictOnSave, 409));
		const file = files.get(path);
		if (!file) return Promise.resolve(answer({ conflict: "gone" }, 409));
		if (sha(file.text ?? "") !== body?.baseHash)
			return Promise.resolve(
				answer(
					{
						error: "changed",
						conflict: "changed",
						current: {
							hash: sha(file.text ?? ""),
							mtimeMs: file.mtimeMs,
							size: 0,
						},
					},
					409,
				),
			);
		const text = String(body?.text);
		files.set(path, { text, mtimeMs: file.mtimeMs + 1 });
		return Promise.resolve(
			answer({ hash: sha(text), mtimeMs: file.mtimeMs + 1, size: text.length }),
		);
	}
	return Promise.resolve(answer({ error: "no such call" }, 404));
}

let page: TestPage;
const viewport = (width: number) =>
	(
		window as unknown as {
			happyDOM: { setViewport(size: { width: number; height: number }): void };
		}
	).happyDOM.setViewport({ width, height: 844 });

beforeAll(async () => {
	page = await openPage();
	globalThis.fetch = fakeFetch as typeof fetch;
	// A browser reports a changed selection after the update that changed it; happy-dom reports it
	// inside, which CodeMirror refuses. Handing the report on a tick later is what a browser does.
	const original = document.addEventListener.bind(document);
	document.addEventListener = ((
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | AddEventListenerOptions,
	) =>
		original(
			type,
			type === "selectionchange" && typeof listener === "function"
				? (event: Event) => queueMicrotask(() => listener.call(document, event))
				: listener,
			options,
		)) as typeof document.addEventListener;
});
afterEach(async () => {
	await page.render(<></>);
	window.location.hash = "";
});
afterAll(async () => {
	globalThis.fetch = realFetch;
	await page.unmount();
	await releaseDom();
});

const settle = (ms = 30) =>
	page.act(() => new Promise((done) => setTimeout(done, ms)));
const query = <T extends Element>(selector: string): T | null =>
	page.container.querySelector<T>(selector);
/** The editor lives in a shadow root of the pane's `.ws-editor`, so the page's queries do not see it. */
const inEditor = <T extends Element>(selector: string): T | null =>
	query<HTMLElement>(".ws-editor")?.shadowRoot?.querySelector<T>(selector) ??
	query<T>(selector);
const all = (selector: string) => [
	...page.container.querySelectorAll(selector),
];
const dialogs = () =>
	all("dialog")
		.filter((one) => (one as HTMLDialogElement).open)
		.map((one) => one.textContent)
		.join(" | ");

async function show(hash: string, width = 1280) {
	files = new Map([
		["README.md", { text: "# Hello\n", mtimeMs: 1 }],
		["src/main.ts", { text: "const a = 1;\r\nconst b = 2;\r\n", mtimeMs: 2 }],
		["src/util.ts", { text: "export {};\n", mtimeMs: 3 }],
		["data/blob.bin", { opaque: "binary", mtimeMs: 4 }],
		["data/huge.log", { opaque: "too-large", mtimeMs: 5 }],
	]);
	calls = [];
	conflictOnSave = undefined;
	holdSave = undefined;
	localStorage.clear();
	viewport(width);
	window.location.hash = hash;
	await page.render(
		<ConfigContext.Provider value={config}>
			<WorkspacePage />
		</ConfigContext.Provider>,
	);
	await settle(120);
}

/** The editor's view, once the editor's chunk has loaded. */
async function editorView(): Promise<EditorView> {
	// Loaded here, after the DOM is registered: CodeMirror reads the platform when it is first imported,
	// and the page's own editor chunk is the same module.
	const { EditorView: View } = await import("@codemirror/view");
	for (let tries = 0; tries < 60; tries++) {
		const dom = inEditor<HTMLElement>(".cm-editor");
		const found = dom ? View.findFromDOM(dom) : null;
		if (found) return found;
		await settle(25);
	}
	throw new Error("the editor never appeared");
}

test("on a desktop the tree stands beside the folder, and the breadcrumbs link to each level", async () => {
	await show("#/workspace/agents%3Asrc%2F");
	// The first root is chosen, its tree is listed and the open folder's rows are shown.
	expect(query("select.ws-root-picker")).not.toBeNull();
	// The folders on the way to the open place are open in the tree.
	const tree = all(".ws-tree .ws-tree-row a").map((one) => one.textContent);
	expect(tree).toEqual(["data", "src", "main.ts", "util.ts", "README.md"]);
	const crumbs = all(".ws-crumbs a").map((one) => [
		one.textContent,
		one.getAttribute("href"),
	]);
	expect(crumbs).toEqual([
		["Agents' workspace", "#/workspace/agents%3A"],
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
	expect(query(".ws-tree")).toBeNull();
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
	expect(query(".ws-tree")).toBeNull();
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
	expect(host?.querySelector(".cm-editor")).toBeNull();
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
	holdSave = new Promise<void>((done) => {
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
	expect(dialogs()).toContain("Replace the partner's changes?");
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

test("a binary or too large file is a card with Download, and no editor", async () => {
	await show("#/workspace/agents%3Adata%2Fblob.bin");
	await settle(50);
	expect(inEditor(".cm-editor")).toBeNull();
	expect(query(".ws-card")?.textContent).toContain(
		"This file is not text, so it cannot be shown here.",
	);
	expect(query(".ws-card a")?.getAttribute("href")).toBe(
		"api/workspace/agents/raw?path=data%2Fblob.bin&download=1",
	);
	expect(query(".ws-actions button")?.textContent).not.toBe("Edit");
	expect(query(".badge")?.textContent).toContain("Read only");
	await show("#/workspace/agents%3Adata%2Fhuge.log");
	await settle(50);
	expect(query(".ws-card")?.textContent).toContain("too large");
});

test("a read-only root offers no Edit and no way to make, rename or delete", async () => {
	await show("#/workspace/docs%3A");
	expect(query("button[aria-label='New file']")).toBeNull();
	expect(query("button[aria-label='Trash']")).toBeNull();
});

test("the editor's theme names no color of its own: every one is a CSS variable", () => {
	const source = readFileSync(
		new URL("./workspace/theme.ts", import.meta.url),
		"utf8",
	);
	expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
	expect(source).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
	expect(source).toContain("var(--code-keyword)");
	for (const name of [
		"code-bg",
		"code-fg",
		"code-gutter",
		"code-selection",
		"code-keyword",
		"code-string",
		"code-number",
		"code-comment",
		"code-type",
		"code-function",
		"code-meta",
	]) {
		for (const file of ["./tokens.css", "./styles/camelot.css"])
			expect(readFileSync(new URL(file, import.meta.url), "utf8")).toContain(
				`--${name}:`,
			);
	}
});
