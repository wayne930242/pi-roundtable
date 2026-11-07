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
	"- `mindmap`: an indented Markdown list; the first item is the root",
	"- `mermaid`: Mermaid source (flowchart, sequence, state, class, ER)",
	"- `diff`: a unified diff",
	"- `alert`: a quote that starts `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]`, optionally followed by a title",
].join("\n");
