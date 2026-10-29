import {
	defaultKeymap,
	history,
	historyKeymap,
	indentMore,
	indentWithTab,
	redo,
	undo,
} from "@codemirror/commands";
import { bracketMatching, indentUnit } from "@codemirror/language";
import {
	highlightSelectionMatches,
	openSearchPanel,
	search,
	searchKeymap,
} from "@codemirror/search";
import {
	Compartment,
	EditorState,
	type Extension,
	type Text,
} from "@codemirror/state";
import {
	drawSelection,
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	lineNumbers,
} from "@codemirror/view";
import type { WorkspaceLanguage } from "../../src/api-types.ts";
import { editorTheme } from "./theme.ts";

// The only module that imports the editor. The page loads it with `import()` the first time a
// file opens, and it loads a language's wrapper (`lang-<name>.ts`) the first time that language
// is shown, so none of CodeMirror is in the page's first download.

type Loader = () => Promise<{ language(): Extension }>;

const LANGUAGES: Record<Exclude<WorkspaceLanguage, "plain">, Loader> = {
	typescript: () => import("./lang-typescript.ts"),
	javascript: () => import("./lang-javascript.ts"),
	json: () => import("./lang-json.ts"),
	markdown: () => import("./lang-markdown.ts"),
	css: () => import("./lang-css.ts"),
	html: () => import("./lang-html.ts"),
	python: () => import("./lang-python.ts"),
	yaml: () => import("./lang-yaml.ts"),
	go: () => import("./lang-go.ts"),
	rust: () => import("./lang-rust.ts"),
	sql: () => import("./lang-sql.ts"),
	xml: () => import("./lang-xml.ts"),
	shell: () => import("./lang-shell.ts"),
	toml: () => import("./lang-toml.ts"),
	dockerfile: () => import("./lang-dockerfile.ts"),
};

/** The highlighting for a language, or none for plain text or one whose chunk failed to load. */
async function languageExtension(
	id: WorkspaceLanguage,
): Promise<Extension | undefined> {
	if (id === "plain") return undefined;
	try {
		return (await LANGUAGES[id]()).language();
	} catch (failure) {
		console.warn("a language for the editor failed to load", failure);
		return undefined;
	}
}

export interface EditorOptions {
	parent: HTMLElement;
	/** The file's text, its own line separators kept. */
	text: string;
	/** The separator Enter inserts and `text()` joins lines with. */
	eol: "\n" | "\r\n";
	language: WorkspaceLanguage;
	editable: boolean;
	wrap: boolean;
	/** The search panel's wording. */
	phrases: Record<string, string>;
	onChange(): void;
	onSave(): void;
	onEscape(): void;
}

/** A document at a moment; opaque to the page. */
export type Snapshot = Text;

export interface EditorHandle {
	/** The whole text with the file's line separator, as a save sends it. */
	text(): string;
	/** Whether the text differs from what was last loaded or saved. */
	dirty(): boolean;
	/** The document as it is now, to hand to `markSaved` once what it holds has been sent. */
	snapshot(): Snapshot;
	/** The text is the saved one now: the snapshot's when one is given, else what is in the editor. */
	markSaved(snapshot?: Snapshot): void;
	/** Replaces the whole document (a reload), keeping the scroll position. */
	replace(text: string, eol: "\n" | "\r\n"): void;
	setEditable(editable: boolean): void;
	setWrap(wrap: boolean): void;
	setLanguage(id: WorkspaceLanguage): Promise<void>;
	undo(): void;
	redo(): void;
	find(): void;
	tab(): void;
	focus(): void;
	scrollTop(): number;
	scrollTo(top: number): void;
	destroy(): void;
}

/**
 * Where the editor goes. The page's Content-Security-Policy has no `style-src`, so it falls back to
 * `default-src 'self'` and the `<style>` element CodeMirror adds to the document is not applied: the
 * editor would come up unstyled. Style rules in a shadow root are adopted as a constructed
 * stylesheet, which that policy does not block, so the editor lives in one; the page's colors and
 * fonts reach it as CSS variables, which cross the boundary. Without the support (an old browser),
 * the editor mounts in the page and takes the policy's word for what it may style.
 */
function mountPoint(host: HTMLElement): {
	parent: HTMLElement | ShadowRoot;
	root: ShadowRoot | undefined;
} {
	if (
		typeof host.attachShadow !== "function" ||
		typeof CSSStyleSheet === "undefined" ||
		!("adoptedStyleSheets" in Document.prototype)
	)
		return { parent: host, root: undefined };
	const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
	const sheet = new CSSStyleSheet();
	sheet.replaceSync(
		":host{display:flex;flex-direction:column;min-height:0}.cm-editor{flex:1;min-height:0}",
	);
	root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
	return { parent: root, root };
}

/** Makes an editor in `parent`. */
export async function createEditor(
	options: EditorOptions,
): Promise<EditorHandle> {
	const editable = new Compartment();
	const wrapping = new Compartment();
	const lang = new Compartment();
	const initialLanguage = await languageExtension(options.language);

	const editableExtensions = (on: boolean): Extension => [
		EditorState.readOnly.of(!on),
		EditorView.editable.of(on),
	];

	// What the editor is set to now, so a replaced document keeps it.
	const now = {
		editable: options.editable,
		wrap: options.wrap,
		language: initialLanguage ?? ([] as Extension),
	};
	let saved: Text | undefined;
	const extensions = (eol: string): Extension[] => [
		lineNumbers(),
		highlightActiveLine(),
		highlightActiveLineGutter(),
		history(),
		drawSelection(),
		bracketMatching(),
		highlightSelectionMatches(),
		search({ top: true }),
		indentUnit.of("  "),
		EditorState.phrases.of(options.phrases),
		editorTheme,
		keymap.of([
			{
				key: "Mod-s",
				preventDefault: true,
				run: () => {
					options.onSave();
					return true;
				},
			},
			{
				key: "Escape",
				run: () => {
					options.onEscape();
					return true;
				},
			},
			indentWithTab,
			...searchKeymap,
			...historyKeymap,
			...defaultKeymap,
		]),
		EditorState.lineSeparator.of(eol),
		editable.of(editableExtensions(now.editable)),
		wrapping.of(now.wrap ? EditorView.lineWrapping : []),
		lang.of(now.language),
		EditorView.updateListener.of((update) => {
			if (update.docChanged) options.onChange();
		}),
	];

	const mount = mountPoint(options.parent);
	const view = new EditorView({
		parent: mount.parent,
		root: mount.root,
		state: EditorState.create({
			doc: options.text,
			extensions: extensions(options.eol),
		}),
	});
	saved = view.state.doc;

	return {
		text: () => view.state.doc.sliceString(0, undefined, view.state.lineBreak),
		dirty: () => saved === undefined || !view.state.doc.eq(saved),
		snapshot: () => view.state.doc,
		markSaved: (snapshot) => {
			saved = snapshot ?? view.state.doc;
		},
		replace: (text, eol) => {
			const top = view.scrollDOM.scrollTop;
			view.setState(
				EditorState.create({ doc: text, extensions: extensions(eol) }),
			);
			saved = view.state.doc;
			view.scrollDOM.scrollTop = top;
		},
		setEditable: (on) => {
			now.editable = on;
			view.dispatch({
				effects: editable.reconfigure(editableExtensions(on)),
			});
		},
		setWrap: (wrap) => {
			now.wrap = wrap;
			view.dispatch({
				effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []),
			});
		},
		setLanguage: async (id) => {
			now.language = (await languageExtension(id)) ?? [];
			view.dispatch({ effects: lang.reconfigure(now.language) });
		},
		undo: () => {
			undo(view);
		},
		redo: () => {
			redo(view);
		},
		find: () => {
			openSearchPanel(view);
		},
		tab: () => {
			indentMore(view);
		},
		focus: () => view.focus(),
		scrollTop: () => view.scrollDOM.scrollTop,
		scrollTo: (top) => {
			view.scrollDOM.scrollTop = top;
		},
		destroy: () => view.destroy(),
	};
}
