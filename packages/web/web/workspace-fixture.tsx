import { afterAll, afterEach, beforeAll } from "bun:test";
import { createHash } from "node:crypto";
import type { EditorView } from "@codemirror/view";
import type {
	ConfigView,
	WorkspaceConflict,
	WorkspaceEntry,
	WorkspaceFileView,
	WorkspaceMedia,
} from "../src/api-types.ts";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { ConfigContext } from "./lib/config.ts";
import { forgetListings, WorkspacePage } from "./pages/workspace.tsx";

export const sha = (text: string) =>
	createHash("sha256").update(text).digest("hex");

export interface Stored {
	text?: string;
	/** Binary or too large: only the metadata. */
	opaque?: "binary" | "too-large";
	mtimeMs: number;
	/** What the raw route can show of it. */
	media?: WorkspaceMedia;
	bytes?: number;
}

/** A workspace in memory, behind the same API the server answers. */
export let files: Map<string, Stored>;
export let calls: {
	method: string;
	url: string;
	body?: Record<string, unknown>;
}[];
/** When set, a PUT answers this instead of saving. */
export let conflictOnSave: WorkspaceConflict | undefined;
/** While set, a save waits for it: keys can be typed while the request is out. */
export const holds: {
	save?: Promise<void> | undefined;
	list?: Promise<void> | undefined;
} = {};
/** While set, a folder listing waits for it: what the pane shows while the next folder is on its way. */

export const config = {
	title: "Test",
	panes: ["rooms", "workspace"],
	timeZone: "UTC",
} as ConfigView;

export const entriesOf = (dir: string): WorkspaceEntry[] => {
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

export const view = (path: string, file: Stored): WorkspaceFileView => {
	const text = file.text ?? "";
	const crlf = text.includes("\r\n");
	return {
		path,
		size: file.bytes ?? text.length,
		mtimeMs: file.mtimeMs,
		hash: sha(text),
		...(file.media ? { media: file.media } : {}),
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

export const answer = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

export const realFetch = globalThis.fetch;
export function fakeFetch(
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
					{ id: "agents", label: "Knights", writable: true },
					{ id: "docs", label: "Docs", writable: false },
				],
			}),
		);
	const action = parts[3];
	if (action === "list" && holds.list)
		return holds.list.then(() => fakeFetch(input, init));
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
	if (action === "file" && method === "PUT" && holds.save) {
		const held = holds.save;
		holds.save = undefined;
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

export let page: TestPage;
export const viewport = (width: number) =>
	(
		window as unknown as {
			happyDOM: { setViewport(size: { width: number; height: number }): void };
		}
	).happyDOM.setViewport({ width, height: 844 });

export const settle = (ms = 30) =>
	page.act(() => new Promise((done) => setTimeout(done, ms)));
export const query = <T extends Element>(selector: string): T | null =>
	page.container.querySelector<T>(selector);
/** The editor lives in a shadow root of the pane's `.ws-editor`, so the page's queries do not see it. */
export const inEditor = <T extends Element>(selector: string): T | null =>
	query<HTMLElement>(".ws-editor")?.shadowRoot?.querySelector<T>(selector) ??
	query<T>(selector);
export const all = (selector: string) => [
	...page.container.querySelectorAll(selector),
];
/** An element named briefly for a failure message: bun prints a whole happy-dom element, with React's fibers, for a failed `toBeNull`. */
export const brief = (element: Element | null | undefined) =>
	element?.outerHTML.slice(0, 120);
export const dialogs = () =>
	all("dialog")
		.filter((one) => (one as HTMLDialogElement).open)
		.map((one) => one.textContent)
		.join(" | ");

export const mediaFiles = (): [string, Stored][] => [
	["pics/a.png", { opaque: "binary", media: "image", bytes: 2048, mtimeMs: 6 }],
	["pics/logo.svg", { text: "<svg/>\n", media: "image", mtimeMs: 7 }],
	["docs/a.pdf", { opaque: "binary", media: "pdf", bytes: 4096, mtimeMs: 8 }],
	["av/a.mp3", { opaque: "binary", media: "audio", bytes: 10, mtimeMs: 9 }],
	["av/a.mp4", { opaque: "binary", media: "video", bytes: 10, mtimeMs: 10 }],
];

export async function show(hash: string, width = 1280) {
	files = new Map([
		["README.md", { text: "# Hello\n", mtimeMs: 1 }],
		["src/main.ts", { text: "const a = 1;\r\nconst b = 2;\r\n", mtimeMs: 2 }],
		["src/util.ts", { text: "export {};\n", mtimeMs: 3 }],
		["data/blob.bin", { opaque: "binary", mtimeMs: 4 }],
		["data/huge.log", { opaque: "too-large", mtimeMs: 5 }],
		...(/pics|docs%2Fa|av%2F/.test(hash) ? mediaFiles() : []),
	]);
	calls = [];
	conflictOnSave = undefined;
	holds.save = undefined;
	holds.list = undefined;
	forgetListings();
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
export async function editorView(): Promise<EditorView> {
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

export async function go(hash: string) {
	window.location.hash = hash;
	await page.act(async () => {
		window.dispatchEvent(new HashChangeEvent("hashchange"));
	});
	await settle(60);
}

/** Registers the setup and cleanup hooks of the suites. */
export function workspacePage(): void {
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
					? (event: Event) =>
							queueMicrotask(() => listener.call(document, event))
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
}
