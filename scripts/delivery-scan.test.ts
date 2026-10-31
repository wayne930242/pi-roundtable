import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
/** The one module that decides where a notice or run for a person goes. */
const ROUTER = "src/core/presence/delivery-router.ts";

/** The shipped sources of the core and the packages: no tests, fixtures, builds, or browser code. */
function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory())
			return ["node_modules", "dist", "testing", "fixtures"].includes(
				entry.name,
			)
				? []
				: sources(path);
		return /\.tsx?$/.test(entry.name) && !/\.(test|e2e)\./.test(entry.name)
			? [path]
			: [];
	});
}

const FILES = [
	...sources(join(ROOT, "src/core")),
	...readdirSync(join(ROOT, "packages")).flatMap((name) => {
		try {
			return sources(join(ROOT, "packages", name, "src"));
		} catch {
			return [];
		}
	}),
].map((path) => ({
	path: relative(ROOT, path),
	text: readFileSync(path, "utf8"),
}));

/** Each line of the sources outside `allowed` that matches `pattern`, as `path:line: text`. */
function hits(pattern: RegExp, allowed: (path: string) => boolean): string[] {
	return FILES.filter(({ path }) => !allowed(path)).flatMap(({ path, text }) =>
		text
			.split("\n")
			.flatMap((line, i) =>
				pattern.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : [],
			),
	);
}

/**
 * The files that read an agent's or group's Discord channel id, and why none of them uses it to
 * pick where a delivery goes: the routing table's `placeOn` is the one that turns it into a place.
 */
const CHANNEL_ID_READERS: Record<string, string> = {
	"src/core/agents/agent-store.ts": "stores the column",
	"src/core/agents/agent-statements.ts": "stores the column",
	"src/core/agents/agent-book.ts":
		"finds the agent a Discord channel belongs to",
	"src/core/agents/team-keys.ts": "names the conversation keys of an agent",
	"src/core/agents/routes.ts": "the routing table: an agent's place on Discord",
	"src/core/agents/team-lifecycle.ts": "checks that the channel still exists",
	"src/core/agents/team-status.ts": "reports the channel in the team status",
	"src/core/agents/team-text.ts": "names the channel in agent_list text",
	"src/core/agents/agent-dashboard.ts":
		"names the channel on the Discord dashboard",
	"src/core/agents/agent-prompt.ts":
		"names the coordinator's channel in a prompt",
	"src/core/agents/team-layout.ts":
		"arranges the Discord channels in categories",
	"src/core/agents/agent-messages.ts":
		"checks that a kept message's Discord channel is still the agent's",
	"src/core/agents/team-helpers.ts":
		"closes or opens a temp knight's Discord thread under a Discord parent",
	"src/core/agents/team-editing.ts":
		"opens a temp knight's Discord thread under a Discord parent",
	"src/core/config/agent-team.ts": "checks the configuration",
	"packages/web/src/console-api.ts":
		"lists the Discord conversations in the console",
	"packages/web/src/cleanup-api.ts":
		"recognises a group's Discord conversation",
	"packages/web/src/connector-manage-api.ts":
		"lists a group's channel for grants",
};

describe("delivery is decided by the router alone", () => {
	test("nothing outside the router asks a direct channel provider to reach someone", () => {
		// A provider's `reaches`, by the provider's name or by a person's id; a socket's own `reaches` is not one.
		const asking =
			/\b\w*[pP]rovider\w*\??\.reaches\??\.?\(|\.reaches\??\.?\(\s*\w*[pP]rincipal/;
		expect(hits(asking, (path) => path === ROUTER)).toEqual([]);
	});

	test("nothing outside the router walks the direct channel providers to pick one", () => {
		const picking =
			/for\s*\(\s*const\s+\w+\s+of\s+[\w.]*providers\(\)|providers\(\)\s*(\.\s*(find|filter|some|at)\s*\(|\[\s*0\s*\])/;
		expect(hits(picking, (path) => path === ROUTER)).toEqual([]);
	});

	test("only the listed files read an agent's or group's Discord channel id, none to deliver", () => {
		const reads =
			/\b(agent|target|group|parent|coordinator|helper|sender|a|g|seed|row|current|named|found|stored)\??\.channelId\b/;
		const found = hits(
			reads,
			(path) =>
				path.startsWith("src/core/discord/") || path in CHANNEL_ID_READERS,
		);
		expect(found).toEqual([]);
	});
});
