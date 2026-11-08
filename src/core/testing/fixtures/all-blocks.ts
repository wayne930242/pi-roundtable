import type { BlockKind } from "pi-better-show";

/** One valid block of each kind, as an agent writes it, by kind. */
export const BLOCK_SAMPLES: Record<BlockKind, string> = {
	alert: "> [!WARNING] Heads up\n> This **overwrites** the cache.",
	cards: [
		"```cards",
		"- {title: Speed, tone: ok, body: 2x faster}",
		"- {title: Risk, tone: warn, body: Needs a migration window}",
		"```",
	].join("\n"),
	options: [
		"```options",
		"- title: SQLite",
		"  recommended: true",
		"  body: Embedded",
		"- title: Postgres",
		"  body: A server to run",
		"```",
	].join("\n"),
	form: [
		"```form",
		"title: Decide the store",
		"questions:",
		"  - name: store",
		"    label: Which store?",
		"    choices: [SQLite, Postgres]",
		"```",
	].join("\n"),
	review: [
		"```review",
		"title: Landing page",
		"items:",
		"  - {name: A, label: dark header, body: Calm}",
		"  - {name: B, label: light header, body: Bright}",
		"```",
	].join("\n"),
	mindmap: ["```mindmap", "- Release", "  - Build", "  - Ship", "```"].join(
		"\n",
	),
	suggest: ["```suggest", "- Go ahead", "- Not now", "```"].join("\n"),
	checklist: [
		"```checklist",
		"title: Before release",
		"items:",
		"  - {label: Run tests, checked: true}",
		"  - {label: Bump version}",
		"```",
	].join("\n"),
	tree: [
		"```tree",
		"repo/",
		"  src/ {changed} # core",
		"  README.md {new}",
		"```",
	].join("\n"),
	table: [
		"```table",
		"columns: [name, size]",
		"rows:",
		"  - [alpha, 1204]",
		"  - [beta, 2]",
		"```",
	].join("\n"),
	steps: [
		"```steps",
		"items:",
		"  - {title: Design, status: done}",
		"  - {title: Build, status: doing}",
		"```",
	].join("\n"),
	stats: [
		"```stats",
		"- {label: Users, value: '1,204', delta: '+4%', tone: ok}",
		"- {label: Errors, value: '3'}",
		"```",
	].join("\n"),
	diff: [
		"```diff",
		"--- a/cache.ts",
		"+++ b/cache.ts",
		"@@ -1,3 +1,3 @@",
		" export function get(key: string) {",
		"-  return store.get(key);",
		"+  return store.get(key) ?? load(key);",
		" }",
		"```",
	].join("\n"),
	mermaid: ["```mermaid", "graph TD", "  A[Start] --> B[Done]", "```"].join(
		"\n",
	),
};

/** A reply that holds a block of every kind between lines of prose. */
export const ALL_BLOCKS_REPLY = [
	"Here is the plan.",
	...Object.values(BLOCK_SAMPLES),
	"That is all.",
].join("\n\n");

/** The fence names of the block kinds, as `grep` finds them at a line start. */
export function fencesIn(text: string): string[] {
	return [...text.matchAll(/^```([a-z]+)/gm)].map((match) => match[1] ?? "");
}
