import type { RoomMessage } from "../src/api-types.ts";

/** The markdown the block-answer cases draw, one sample of each interactive block. */
export const OPTIONS = [
	"```options",
	"- title: SQLite",
	"- title: Postgres",
	"```",
].join("\n");
export const SUGGEST = ["```suggest", "- Ship it", "- Wait", "```"].join("\n");
export const WORDY_SUGGEST = [
	"```suggest",
	'- {label: Yes, text: "Yes. I approve deleting the staging database, go ahead"}',
	"- Wait",
	"```",
].join("\n");
export const FORM = [
	"```form",
	"title: Stores",
	"questions:",
	"  - name: store",
	"    type: single",
	"    required: true",
	"    choices: [{value: SQLite, label: SQLite}, {value: Postgres, label: Postgres}]",
	"```",
].join("\n");
export const HIDDEN_FORM = [
	"```form",
	"questions:",
	"  - name: db",
	"    label: Which database",
	"    type: single",
	"    choices: [{value: pg-17-prod, label: Postgres}, {value: lite, label: SQLite}]",
	"```",
].join("\n");
export const MULTI_FORM = [
	"```form",
	"title: Extras",
	"questions:",
	"  - name: extras",
	"    type: multi",
	"    required: true",
	"    choices: [{value: Cache, label: Cache}, {value: Queue, label: Queue}]",
	"```",
].join("\n");
export const CHECKLIST = [
	"```checklist",
	"title: Before the release",
	"items: [Tests, Docs]",
	"```",
].join("\n");
export const REVIEW = [
	"```review",
	"title: Two logos",
	"pick: true",
	"items:",
	"  - {name: A, body: First, image: 'file:logo-a'}",
	"  - {name: B, body: Second, image: 'https://example.test/b.png', page: proto.html}",
	"  - {name: C, body: Third, image: 'file:..'}",
	"  - {name: D, body: An SVG comp the agent attached, image: 'file:comp-svg_1'}",
	"```",
].join("\n");

/** An agent's stored reply in the guide's room, with the id the caller gives it. */
export const agentReply = (
	id: number,
	text: string,
	over: Partial<RoomMessage> = {},
): RoomMessage => ({
	id,
	room: "app:agent.guide",
	kind: "agent",
	agent: "guide",
	author: "Guide",
	text,
	files: [],
	at: "2026-11-08T10:00:00.000Z",
	...over,
});
