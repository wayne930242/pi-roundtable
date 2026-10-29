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

export interface EditorHandle {
	/** The whole text with the file's line separator, as a save sends it. */
	text(): string;
	/** Whether the text differs from what was last loaded or saved. */
	dirty(): boolean;
	/** The text is the saved one now. */
	markSaved(): void;
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
		editable.of(editableExtensions(options.editable)),
		wrapping.of(options.wrap ? EditorView.lineWrapping : []),
		lang.of(initialLanguage ?? []),
		EditorView.updateListener.of((update) => {
			if (update.docChanged) options.onChange();
		}),
	];

	const view = new EditorView({
		parent: options.parent,
		state: EditorState.create({
			doc: options.text,
			extensions: extensions(options.eol),
		}),
	});
	saved = view.state.doc;

	return {
		text: () => view.state.doc.sliceString(0, undefined, view.state.lineBreak),
		dirty: () => saved === undefined || !view.state.doc.eq(saved),
		markSaved: () => {
			saved = view.state.doc;
		},
		replace: (text, eol) => {
			const top = view.scrollDOM.scrollTop;
			view.setState(
				EditorState.create({ doc: text, extensions: extensions(eol) }),
			);
			saved = view.state.doc;
			view.scrollDOM.scrollTop = top;
		},
		setEditable: (on) =>
			view.dispatch({
				effects: editable.reconfigure(editableExtensions(on)),
			}),
		setWrap: (wrap) =>
			view.dispatch({
				effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []),
			}),
		setLanguage: async (id) => {
			view.dispatch({
				effects: lang.reconfigure((await languageExtension(id)) ?? []),
			});
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
