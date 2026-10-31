import type { Tier } from "pi-roundtable";

/**
 * Who a route answers, as the authorization table of the design names them:
 * - `O`: a person whose tier is owner, read again for the request;
 * - `V`: any admitted viewer (owner, admin, member) who is past the gate;
 * - `G`: any admitted viewer, gated or not.
 * A route answers more narrowly inside its handler (a member's own notes, a room the kind
 * grants); this table is the first check, and it runs before any handler does.
 */
export type Who = "G" | "V" | "O";

export interface Rule {
	/** The methods the row covers; `*` is every method. */
	methods: readonly string[] | "*";
	/**
	 * The path below the mount: segments joined by `/`. `:name` is one segment; a last `**` is any
	 * number of further segments, none included.
	 */
	path: string;
	who: Who;
	/** A refusal says 404, not 403: the route's existence is not for this person to learn. */
	hide?: true;
}

const row = (
	methods: Rule["methods"],
	path: string,
	who: Who,
	hide?: true,
): Rule => ({ methods, path, who, ...(hide ? { hide } : {}) });

/** The app's REST routes by who they answer. A route that is not listed answers 404 to everyone. */
export const ROUTES: readonly Rule[] = [
	// The page and its data.
	row(["GET"], "api/config", "G"),
	row(["GET"], "api/session", "G"),
	row(["GET"], "api/events", "O"),
	row("*", "api/overview", "O"),
	row("*", "api/dashboard", "O"),
	row("*", "api/channels/:id/:action", "O"),
	row("*", "api/skills", "O"),
	row("*", "api/skills/:name", "O"),
	row("*", "api/connectors", "O"),
	row("*", "api/connectors/**", "O"),
	row("*", "api/models", "O"),
	// The owner's conversations; a member's own are filtered inside the handler.
	row("*", "api/conversations", "V"),
	row("*", "api/conversations/:id", "V"),
	// Notes: the visitor's own (inside the handler); the owner's reads of others stay as they were.
	row("*", "api/notes", "V"),
	row("*", "api/notes/:id", "V"),
	row("*", "api/principals", "V"),
	// The agent rooms are the owners'. The route says 404, not 403, to anyone else. Their threads are under
	// it too: a thread's view and `…/dismiss`, and `…/dismiss-threads` of its parent.
	row("*", "api/rooms", "O", true),
	row("*", "api/rooms/**", "O", true),
	row("*", "api/folders/**", "O"),
	row("*", "api/agents/**", "O"),
	row("*", "api/groups/**", "O"),
	row("*", "api/archive/**", "O"),
	row("*", "api/prompts/**", "O"),
	row("*", "api/skill-docs/**", "O"),
	row("*", "api/workspace/**", "O"),
	row(["GET", "HEAD"], "avatars/:file", "V"),
	// Uploads and files: the upload is the sender's own; a file answers by the room it is bound to.
	row("*", "api/uploads", "V"),
	row("*", "api/uploads/:id", "V"),
	row("*", "api/files/:id", "V"),
	// Schedules: the owner's all, a member's own (inside the handler).
	row("*", "api/schedules", "V"),
	row("*", "api/schedules/:id", "V"),
	// Host rooms and pages: the kind's `access` and the page's `visible` decide inside.
	row(["GET"], "api/host/:kind", "V"),
	row(["GET"], "api/host/:kind/:id", "V"),
	row(["GET"], "api/host/:kind/:id/messages", "V"),
	row(["POST"], "api/host/:kind/:id/act", "V"),
	row(["GET"], "api/pages/:id", "V"),
	row(["POST"], "api/pages/:id/act", "V"),
	// Notices, push, the profile, links and onboarding are the person's own (the session's principal).
	row(["GET"], "api/notices", "G"),
	row(["POST"], "api/notices/:tag/ack", "G"),
	row(["GET"], "api/push/key", "G"),
	row("*", "api/push/subscriptions", "G"),
	row("*", "api/push/subscriptions/:id", "G"),
	row(["POST"], "api/push/test", "G"),
	row(["POST"], "api/push/receipts", "G"),
	row(["GET", "PUT"], "api/push/prefs", "G"),
	row(["GET"], "api/profile", "G"),
	row(["PUT"], "api/profile/source", "G"),
	row(["GET"], "api/people/:id/picture", "G"),
	row(["GET"], "api/links", "G"),
	row(["POST"], "api/links/:provider/:step", "G"),
	row(["DELETE"], "api/links/:provider", "G"),
	row(["GET"], "api/onboarding", "G"),
	row(["POST"], "api/onboarding/:step/waive", "G"),
];

function matches(pattern: string, parts: readonly string[]): boolean {
	const want = pattern.split("/");
	const open = want[want.length - 1] === "**";
	const fixed = open ? want.slice(0, -1) : want;
	if (open ? parts.length < fixed.length : parts.length !== fixed.length)
		return false;
	return fixed.every(
		(segment, at) => segment.startsWith(":") || segment === parts[at],
	);
}

/** The parts of a path below the mount, decoded; undefined for one that does not decode. */
function partsOf(rest: string): string[] | undefined {
	try {
		return rest.split("/").filter(Boolean).map(decodeURIComponent);
	} catch {
		return undefined;
	}
}

/** The path areas the table governs: everything below `api/` and the avatars. */
const governed = (parts: readonly string[]): boolean =>
	parts[0] === "api" || parts[0] === "avatars";

export interface Subject {
	tier: Tier;
	/** A required onboarding step stands undone. */
	gated: boolean;
}

export type Decision =
	| { allow: true; rule?: Rule }
	| { allow: false; status: 403 | 404; gate?: true; reason: string };

/**
 * Decides a request before any handler sees it. A page, an asset or the install files (anything
 * outside `api/` and `avatars/`) needs only an admitted visitor. A route under them that the table
 * does not list answers 404. A listed route whose method the row does not list is judged by the
 * strictest row of its path and then left to the handler to refuse as the method it is.
 */
export function decide(
	method: string,
	rest: string,
	subject: Subject,
): Decision {
	const parts = partsOf(rest);
	if (!parts) return { allow: false, status: 404, reason: "undecodable path" };
	if (!governed(parts)) return { allow: true };
	const found = ROUTES.filter((rule) => matches(rule.path, parts));
	if (found.length === 0)
		return { allow: false, status: 404, reason: "not in the table" };
	const exact = found.find(
		(rule) => rule.methods === "*" || rule.methods.includes(method),
	);
	const rule = exact ?? strictest(found);
	if (subject.gated && rule.who !== "G")
		return {
			allow: false,
			status: 403,
			gate: true,
			reason: "an onboarding step stands undone",
		};
	if (rule.who === "O" && subject.tier !== "owner")
		return {
			allow: false,
			status: rule.hide ? 404 : 403,
			reason: "owners only",
		};
	return { allow: true, rule };
}

const ORDER: Record<Who, number> = { G: 0, V: 1, O: 2 };

function strictest(rules: readonly Rule[]): Rule {
	return rules.reduce((a, b) => (ORDER[b.who] > ORDER[a.who] ? b : a));
}
