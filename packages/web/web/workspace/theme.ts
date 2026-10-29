import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

// Every color is a CSS variable (tokens.css and styles/camelot.css), so a look or a light/dark
// switch recolors the open editor at once and nothing here is rebuilt.

const chrome = EditorView.theme({
	"&": {
		color: "var(--code-fg)",
		backgroundColor: "var(--code-bg)",
		height: "100%",
		fontSize: "var(--code-size, 13px)",
	},
	"&.cm-focused": { outline: "none" },
	".cm-scroller": {
		fontFamily: "var(--font-mono)",
		lineHeight: "1.55",
		overflow: "auto",
	},
	".cm-content": {
		caretColor: "var(--code-fg)",
		padding: "0.5rem 0",
	},
	".cm-line": { padding: "0 0.75rem" },
	".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--code-fg)" },
	"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
		{ backgroundColor: "var(--code-selection)" },
	".cm-activeLine": { backgroundColor: "var(--code-active-line)" },
	".cm-gutters": {
		backgroundColor: "var(--code-gutter-bg)",
		color: "var(--code-gutter)",
		border: "none",
		borderRight: "1px solid var(--border)",
	},
	".cm-activeLineGutter": {
		backgroundColor: "var(--code-active-line)",
		color: "var(--code-fg)",
	},
	".cm-lineNumbers .cm-gutterElement": {
		padding: "0 0.5rem 0 0.5rem",
		minWidth: "2.25rem",
	},
	".cm-matchingBracket, .cm-nonmatchingBracket": {
		backgroundColor: "var(--code-selection)",
		outline: "1px solid var(--border-strong)",
	},
	".cm-searchMatch": {
		backgroundColor: "var(--warn-soft)",
		outline: "1px solid var(--warn)",
	},
	".cm-searchMatch.cm-searchMatch-selected": {
		backgroundColor: "var(--accent-soft)",
		outline: "1px solid var(--accent)",
	},
	".cm-panels": {
		backgroundColor: "var(--surface-2)",
		color: "var(--text)",
		borderColor: "var(--border)",
		fontFamily: "var(--font)",
	},
	".cm-panels-top": { borderBottom: "1px solid var(--border)" },
	".cm-panel.cm-search": { padding: "0.5rem 2rem 0.5rem 0.5rem" },
	".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label":
		{ fontSize: "0.875rem" },
	".cm-panel.cm-search input[type=text]": {
		backgroundColor: "var(--surface)",
		color: "var(--text)",
		border: "1px solid var(--control-border)",
		borderRadius: "var(--radius-sm)",
		padding: "0.25rem 0.5rem",
	},
	".cm-panel.cm-search button": {
		backgroundColor: "var(--surface-3)",
		color: "var(--text)",
		border: "1px solid var(--border-strong)",
		borderRadius: "var(--radius-sm)",
		backgroundImage: "none",
		padding: "0.25rem 0.625rem",
	},
	".cm-panel.cm-search [name=close]": { color: "var(--muted)" },
});

const highlight = HighlightStyle.define([
	{
		tag: [
			tags.keyword,
			tags.modifier,
			tags.operatorKeyword,
			tags.controlKeyword,
		],
		color: "var(--code-keyword)",
	},
	{
		tag: [tags.string, tags.regexp, tags.special(tags.string), tags.inserted],
		color: "var(--code-string)",
	},
	{
		tag: [tags.number, tags.bool, tags.null, tags.atom, tags.literal],
		color: "var(--code-number)",
	},
	{
		tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
		color: "var(--code-comment)",
		fontStyle: "italic",
	},
	{
		tag: [
			tags.typeName,
			tags.className,
			tags.namespace,
			tags.tagName,
			tags.standard(tags.tagName),
		],
		color: "var(--code-type)",
	},
	{
		tag: [
			tags.function(tags.variableName),
			tags.function(tags.propertyName),
			tags.definition(tags.variableName),
			tags.labelName,
		],
		color: "var(--code-function)",
	},
	{
		tag: [
			tags.meta,
			tags.processingInstruction,
			tags.annotation,
			tags.attributeName,
			tags.propertyName,
			tags.heading,
		],
		color: "var(--code-meta)",
	},
	{ tag: tags.heading, fontWeight: "bold" },
	{ tag: tags.strong, fontWeight: "bold" },
	{ tag: tags.emphasis, fontStyle: "italic" },
	{ tag: tags.strikethrough, textDecoration: "line-through" },
	{
		tag: tags.link,
		color: "var(--code-function)",
		textDecoration: "underline",
	},
	{ tag: tags.url, color: "var(--code-function)" },
	{ tag: tags.invalid, color: "var(--danger)" },
	{ tag: tags.deleted, color: "var(--danger)" },
]);

/** The editor's look: chrome and highlighting, in CSS variables only. */
export const editorTheme: Extension = [chrome, syntaxHighlighting(highlight)];
