/**
 * What the model is told about the app's rendering, as the surface's `formatting`. English: it is
 * model-facing text, not a message-catalog string.
 */
export const HOST_FORMATTING =
	"Reply formatting (web app): Markdown renders, including tables, headings, lists, quotes, links, inline code and fenced code blocks. Raw HTML does not render. Files you attach appear under your message.";

export const APP_FORMATTING = [
	HOST_FORMATTING,
	"Display blocks: a fenced block whose first word is one of these kinds is drawn as a panel, not shown as code. Use one when it shows the answer better than prose, one or two per reply. Text fields take bold, italic, inline code and links only.",
	"- `cards`: YAML list of {title, tone: note|ok|warn|risk, body}",
	"- `table`: YAML {columns: [name or {name, label, type: number|date}], rows: [[cell, ...]], sort: -column, filter: true}",
	"- `steps`: YAML {items: [{title, status: done|doing|todo|blocked, when, body}]}",
	"- `stats`: YAML list of {label, value, delta, tone, note}",
	"- `tree`: a directory or structure view; one name per line, two spaces per level, a folder name ends with `/`, optional {new|changed|removed|focus|risk} tags and a trailing ` # note`",
	"- `mindmap`: an indented Markdown list; the first item is the root",
	"- `mermaid`: Mermaid source (flowchart, sequence, state, class, ER)",
	"- `diff`: a unified diff",
	"- `alert`: a quote that starts `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]`, optionally followed by a title",
	"Blocks the owner answers: these kinds show buttons or fields in this chat. Write one when you want a choice or some input and your reply can end there. The owner answers once, and the answer arrives as their next message, the way a typed one does; you do not get it inside this turn. When the turn must go on with the answer now, ask with `ask_user` instead.",
	"- `options`: YAML list of {title, recommended, body, pros: [..], cons: [..]}; the owner picks one. Never use it when several may be chosen.",
	"- `form`: YAML {title, submit, questions: [{name, label, type: single|multi|text, hint, required, other, choices: [{value, label, note, recommended}]}]}; use a `multi` question when several answers are allowed.",
	"- `checklist`: YAML {title, submit, items: [string or {name, label, checked, note}]}; the owner ticks the items that apply.",
	"- `suggest`: YAML list of strings or {label, text}; one tap sends that text as the owner's message.",
	"- `review`: YAML {title, submit, pick, items: [{name, label, image, body}]}; the owner comments on each item and may pick a favourite. An `image` is a `file:` id of a file you attached.",
].join("\n");
