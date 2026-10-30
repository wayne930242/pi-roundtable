import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Tier } from "pi-roundtable";
import { decide, ROUTES, type Subject } from "./authz.ts";

type Outcome = "allow" | 403 | 404 | "gate";

const SUBJECTS: Record<string, Subject> = {
	owner: { tier: "owner", gated: false },
	admin: { tier: "admin", gated: false },
	member: { tier: "member", gated: false },
	"gated member": { tier: "member", gated: true },
	"gated owner": { tier: "owner", gated: true },
};

function outcome(method: string, rest: string, subject: Subject): Outcome {
	const decision = decide(method, rest, subject);
	if (decision.allow) return "allow";
	return decision.gate ? "gate" : decision.status;
}

/** What owner, admin, member and a gated member each get, per the authorization table of the design. */
const O: Record<string, Outcome> = {
	owner: "allow",
	admin: 403,
	member: 403,
	"gated member": "gate",
	"gated owner": "gate",
};
const V: Record<string, Outcome> = {
	owner: "allow",
	admin: "allow",
	member: "allow",
	"gated member": "gate",
	"gated owner": "gate",
};
const G: Record<string, Outcome> = {
	owner: "allow",
	admin: "allow",
	member: "allow",
	"gated member": "allow",
	"gated owner": "allow",
};
/** An owners-only route that answers 404 to the others: its existence is not theirs to learn. */
const HIDDEN: Record<string, Outcome> = { ...O, admin: 404, member: 404 };

/** [method, path below the mount, who]. Each is a route a router answers. */
const EXPECTED: [string, string, Record<string, Outcome>][] = [
	["GET", "api/config", G],
	["GET", "api/session", G],
	["GET", "api/events", O],
	["GET", "api/overview", O],
	["GET", "api/dashboard", O],
	["POST", "api/channels/123/start-over", O],
	["POST", "api/channels/123/delete", O],
	["GET", "api/skills", O],
	["GET", "api/skills/review", O],
	["GET", "api/connectors", O],
	["GET", "api/models", O],
	["GET", "api/conversations", V],
	["GET", "api/conversations/abc", V],
	["GET", "api/notes", V],
	["POST", "api/notes", V],
	["DELETE", "api/notes/5", V],
	["GET", "api/principals", V],
	["GET", "api/rooms", HIDDEN],
	["GET", "api/rooms/app%3Aagent.guide/messages", HIDDEN],
	["PUT", "api/rooms/app%3Aagent.guide/mode", HIDDEN],
	["POST", "api/rooms/app%3Aagent.guide/start-over", HIDDEN],
	["PUT", "api/rooms/app%3Aagent.guide/pin", HIDDEN],
	["PUT", "api/rooms/app%3Aagent.guide/folder", HIDDEN],
	["PUT", "api/rooms/app%3Aagent.guide/mute", HIDDEN],
	["GET", "api/rooms/app%3Athread.0b5e7c1a", HIDDEN],
	["POST", "api/rooms/app%3Athread.0b5e7c1a/dismiss", HIDDEN],
	["POST", "api/rooms/app%3Aagent.guide/dismiss-threads", HIDDEN],
	["POST", "api/rooms/app%3Athread.0b5e7c1a/undismiss", HIDDEN],
	["POST", "api/rooms/app%3Aagent.guide/undismiss-threads", HIDDEN],
	["POST", "api/folders", O],
	["PATCH", "api/folders/folder.x", O],
	["PUT", "api/folders/folder.x/mute", O],
	["GET", "api/agents", O],
	["POST", "api/agents", O],
	["PATCH", "api/agents/scout", O],
	["GET", "api/groups", O],
	["PUT", "api/groups/team", O],
	["GET", "api/archive", O],
	["GET", "api/prompts", O],
	["PUT", "api/prompts/main", O],
	["GET", "api/skill-docs", O],
	["GET", "api/workspace/tree", O],
	["PUT", "api/workspace/file", O],
	["GET", "avatars/abc.png", V],
	["POST", "api/uploads", V],
	["DELETE", "api/uploads/u1", V],
	["GET", "api/files/f1", V],
	["GET", "api/schedules", V],
	["DELETE", "api/schedules/s1", V],
	["GET", "api/host/case", V],
	["GET", "api/host/case/c1", V],
	["GET", "api/host/case/c1/messages", V],
	["POST", "api/host/case/c1/act", V],
	["GET", "api/pages/crm", V],
	["POST", "api/pages/crm/act", V],
	["GET", "api/notices", G],
	["POST", "api/notices/tag/ack", G],
	["GET", "api/push/key", G],
	["GET", "api/push/subscriptions", G],
	["POST", "api/push/subscriptions", G],
	["DELETE", "api/push/subscriptions/d1", G],
	["POST", "api/push/test", G],
	["POST", "api/push/receipts", G],
	["GET", "api/push/prefs", G],
	["PUT", "api/push/prefs", G],
	["GET", "api/profile", G],
	["PUT", "api/profile/source", G],
	["GET", "api/people/p1/picture", G],
	["GET", "api/links", G],
	["POST", "api/links/google/start", G],
	["DELETE", "api/links/google", G],
	["GET", "api/onboarding", G],
	["POST", "api/onboarding/step/waive", G],
];

describe("the authorization table", () => {
	for (const [method, path, want] of EXPECTED) {
		test(`${method} ${path}`, () => {
			for (const [name, subject] of Object.entries(SUBJECTS))
				expect({ who: name, got: outcome(method, path, subject) }).toEqual({
					who: name,
					got: want[name] as Outcome,
				});
		});
	}

	test("a route the table does not list answers 404 to everyone, owners included", () => {
		for (const path of [
			"api/unknown",
			"api/rooms-secret",
			"api/host",
			"api/push",
			"api/notices/tag",
			"avatars",
			"avatars/a/b",
			"api",
		])
			for (const [name, subject] of Object.entries(SUBJECTS))
				expect({ path, who: name, got: outcome("GET", path, subject) }).toEqual(
					{ path, who: name, got: 404 },
				);
	});

	test("a path that does not decode is not routed", () => {
		expect(
			outcome("GET", "api/rooms/%E0%A4%A", SUBJECTS.owner as Subject),
		).toBe(404);
	});

	test("a page, an asset or an install file needs only an admitted visitor, gated or not", () => {
		for (const path of [
			"",
			"index.html",
			"sw.js",
			"manifest.webmanifest",
			"assets/app.js",
			"icons/icon-192.png",
		])
			for (const subject of Object.values(SUBJECTS))
				expect(outcome("GET", path, subject)).toBe("allow");
	});

	test("a gated visitor is told so on every route that is not the person's own", () => {
		for (const rule of ROUTES) {
			const path = rule.path.replace(/:[a-z]+/g, "x").replace(/\*\*$/, "x");
			const method = rule.methods === "*" ? "GET" : (rule.methods[0] as string);
			const got = outcome(method, path, { tier: "owner", gated: true });
			expect({ path, got }).toEqual({
				path,
				got: rule.who === "G" ? "allow" : "gate",
			});
		}
	});

	test("a method a row does not list is judged by the strictest row of its path", () => {
		// `api/profile` is a G row for GET only: a DELETE of it is not a G request.
		expect(
			outcome("DELETE", "api/profile", SUBJECTS["gated member"] as Subject),
		).toBe("allow");
		expect(outcome("DELETE", "api/links", SUBJECTS.member as Subject)).toBe(
			"allow",
		);
	});

	test("every area the three routers answer has a row", () => {
		const source = (file: string) =>
			readFileSync(join(import.meta.dir, file), "utf8");
		const areas = new Set<string>();
		// console-api.ts: `head === "<area>"`.
		for (const found of source("console-api.ts").matchAll(
			/head === "([a-z-]+)"/g,
		))
			areas.add(`api/${found[1]}`);
		// app/routes.ts: the list of areas it claims.
		const routes = source("app/routes.ts");
		const list = /\[\s*"session",[^\]]*\]/s.exec(routes)?.[0] ?? "";
		for (const found of list.matchAll(/"([a-z-]+)"/g))
			areas.add(`api/${found[1]}`);
		areas.add("avatars/x");
		// push/api.ts: `api/push/<name>`.
		for (const found of source("push/api.ts").matchAll(/name === "([a-z]+)"/g))
			areas.add(`api/push/${found[1]}`);
		expect(areas.size).toBeGreaterThan(20);
		const listed = (area: string) =>
			ROUTES.some((rule) => {
				const want = rule.path.split("/");
				const have = area.split("/");
				const open = want[want.length - 1] === "**";
				const fixed = open ? want.slice(0, -1) : want;
				return fixed.every(
					(part, at) => part.startsWith(":") || part === have[at],
				);
			});
		const missing = [...areas].filter((area) => !listed(area));
		expect(missing).toEqual([]);
	});

	test("the round table adds no route: a member's seats come from the host lists, and everything the owners' table reads stays closed to them", () => {
		const member = SUBJECTS.member as Subject;
		const admin = SUBJECTS.admin as Subject;
		for (const who of [member, admin]) {
			// What a hosted table reads: the kinds' lists, and the room a seat opens.
			for (const [method, path] of [
				["GET", "api/host/inbox"],
				["GET", "api/host/inbox/abcdefgh"],
				["GET", "api/host/inbox/abcdefgh/messages"],
			] as const)
				expect(outcome(method, path, who)).toBe("allow");
			// What the owners' table reads and writes: the agent rooms, their mute, the presence of the team, and the other panes' data.
			for (const [method, path] of [
				["GET", "api/rooms"],
				["PUT", "api/rooms/app:agent.guide/mute"],
				["GET", "api/rooms/app:agent.guide"],
				["GET", "api/agents/guide"],
				["GET", "api/groups/crew"],
				["GET", "api/overview"],
				["GET", "api/workspace/roots"],
				["GET", "api/skills"],
			] as const)
				expect(outcome(method, path, who)).not.toBe("allow");
		}
		expect(outcome("PUT", "api/rooms/app:agent.guide/mute", member)).toBe(404);
	});

	test("the table lists no tier that the type does not know", () => {
		const tiers: Tier[] = ["owner", "admin", "member"];
		for (const rule of ROUTES) expect(["G", "V", "O"]).toContain(rule.who);
		expect(tiers).toHaveLength(3);
	});
});
