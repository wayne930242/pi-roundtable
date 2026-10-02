import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	archiveNames,
	parseKey,
	readTranscript,
	storedConversations,
} from "./conversations.ts";
import { DEFAULT_RELAY_NOTE } from "./options.ts";
import {
	fixtureSessions,
	OUTSIDE_SESSION,
	OWNER_CHANNEL,
	sessionFile,
} from "./testing/fixtures.ts";

const none = () => false;
const relayNotes = [DEFAULT_RELAY_NOTE];

test("lists owner and outside conversations, newest first, and ignores other directories", () => {
	const sessions = join(fixtureSessions(), "sessions");
	const found = storedConversations(sessions, { excluded: none, relayNotes });
	expect(found.map((c) => c.key)).toEqual([
		`mcp:${OUTSIDE_SESSION}`,
		"discord:900000000000000002",
		`discord:${OWNER_CHANNEL}`,
		"agentgroup:900000000000000003.scout",
		"discord:900000000000000004",
	]);
	const owner = found.find((c) => c.key === `discord:${OWNER_CHANNEL}`);
	expect(owner?.archives).toBe(1);
	expect(owner?.liveBytes).toBeGreaterThan(0);
	expect(owner?.lastActive).toBe("2026-09-02T10:05:00.000Z");
});

test("an outside conversation shows its first message without the relay note, and when it began", () => {
	const sessions = join(fixtureSessions(), "sessions");
	const [outside] = storedConversations(sessions, {
		excluded: none,
		relayNotes,
	});
	expect(outside?.firstMessage).toBe("Please summarise the report");
	expect(outside?.startedAt).toBe("2026-09-04T09:00:00.000Z");
});

test("excluded channels are left out", () => {
	const sessions = join(fixtureSessions(), "sessions");
	const found = storedConversations(sessions, {
		excluded: (key) => key === "discord:900000000000000004",
		relayNotes,
	});
	expect(found.map((c) => c.key)).not.toContain("discord:900000000000000004");
});

test("a conversation with only archives is listed with no live bytes, dated by its archive", () => {
	const dataDir = fixtureSessions();
	const sessions = join(dataDir, "sessions");
	const dir = join(sessions, "discord_900000000000000005", "archive", "t1");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "a.jsonl"), sessionFile([]));
	const found = storedConversations(sessions, { excluded: none, relayNotes });
	const archived = found.find((c) => c.id === "900000000000000005");
	expect(archived?.liveBytes).toBe(0);
	expect(archived?.archives).toBe(1);
	expect(archived?.lastActive).toBeDefined();
});

test("a group member's conversation is listed under the core's group key, with the member", () => {
	const sessions = join(fixtureSessions(), "sessions");
	const found = storedConversations(sessions, { excluded: none, relayNotes });
	const member = found.find((c) => c.kind === "group");
	expect(member).toMatchObject({
		key: "agentgroup:900000000000000003.scout",
		id: "900000000000000003",
		member: "scout",
	});
	const dir = join(sessions, "agentgroup_900000000000000003_scout");
	expect(
		readTranscript(dir, undefined, relayNotes).entries.map((e) => e.text),
	).toEqual(["Group topic"]);
});

test("a missing sessions directory lists nothing", () => {
	expect(
		storedConversations("/nonexistent-sessions", {
			excluded: none,
			relayNotes,
		}),
	).toEqual([]);
});

test("parseKey accepts only the two key shapes", () => {
	expect(parseKey(`discord:${OWNER_CHANNEL}`)?.dir).toBe(
		`discord_${OWNER_CHANNEL}`,
	);
	expect(parseKey(`mcp:${OUTSIDE_SESSION}`)?.kind).toBe("mcp");
	expect(parseKey("agentgroup:900000000000000003.scout")).toEqual({
		dir: "agentgroup_900000000000000003_scout",
		kind: "group",
		id: "900000000000000003",
		member: "scout",
	});
	for (const key of [
		"discord:12",
		"discord:../../etc",
		"mcp:../x",
		"agentgroup:900000000000000003.../x",
		"agentgroup:900000000000000003.a/b",
		"agentgroup:12.scout",
		`discord:${OWNER_CHANNEL}/x`,
		"other:1",
		"",
	])
		expect(parseKey(key)).toBeUndefined();
});

test("a transcript shows messages, calls, and results, and leaves out the system prompt and reasoning", () => {
	const dir = join(fixtureSessions(), "sessions", `discord_${OWNER_CHANNEL}`);
	const { entries, truncated } = readTranscript(dir, undefined, relayNotes);
	expect(truncated).toBe(false);
	expect(entries.map((e) => e.role)).toEqual([
		"user",
		"assistant",
		"tool",
		"assistant",
	]);
	expect(entries[0]?.text).toBe("What is on my calendar?");
	expect(entries[1]?.text).toBe("Let me check.");
	expect(entries[1]?.calls).toEqual([
		{ name: "calendar_list", preview: '{"day":"today"}' },
	]);
	expect(entries[2]).toMatchObject({
		tool: "calendar_list",
		text: "09:00 stand-up",
	});
	expect(JSON.stringify(entries)).not.toContain("SYSTEM PROMPT");
	expect(JSON.stringify(entries)).not.toContain("private reasoning");
});

test("an archive is read on its own, chosen from the folder's listing", () => {
	const dir = join(fixtureSessions(), "sessions", `discord_${OWNER_CHANNEL}`);
	const [archive] = archiveNames(dir);
	expect(archive).toBe("2026-08-30T08-00-00.000Z");
	const { entries } = readTranscript(dir, archive, relayNotes);
	expect(entries.map((e) => e.text)).toEqual([
		"An older question",
		"An older answer",
	]);
});

test("relay notes come off a user message", () => {
	const dir = join(fixtureSessions(), "sessions", `mcp_${OUTSIDE_SESSION}`);
	const { entries } = readTranscript(dir, undefined, relayNotes);
	expect(entries[0]?.text).toBe("Please summarise the report");
});

test("a line cut off mid-write is skipped, not fatal", () => {
	const dir = join(fixtureSessions(), "sessions", `discord_${OWNER_CHANNEL}`);
	appendFileSync(
		join(dir, "2026-09-02T10-00-00-000Z_live.jsonl"),
		'{"type":"message","message":{"role":"user","content":[{"type":"te',
	);
	const { entries } = readTranscript(dir, undefined, relayNotes);
	expect(entries).toHaveLength(4);
});

test("a very long conversation shows its end and says it was cut", () => {
	const dir = join(fixtureSessions(), "sessions", `discord_${OWNER_CHANNEL}`);
	const many = Array.from({ length: 1200 }, (_, i) => ({
		role: "user",
		content: [{ type: "text", text: `message ${i}` }],
	}));
	writeFileSync(
		join(dir, "2026-09-03T00-00-00-000Z_big.jsonl"),
		sessionFile(many),
	);
	const { entries, truncated } = readTranscript(dir, undefined, relayNotes);
	expect(truncated).toBe(true);
	expect(entries).toHaveLength(1000);
	expect(entries.at(-1)?.text).toBe("message 1199");
});

test("a file over the byte budget is read from its tail", () => {
	const dir = join(fixtureSessions(), "sessions", `discord_${OWNER_CHANNEL}`);
	const filler = "x".repeat(4000);
	const many = Array.from({ length: 2500 }, (_, i) => ({
		role: "user",
		content: [{ type: "text", text: `${i} ${filler}` }],
	}));
	writeFileSync(
		join(dir, "2026-09-03T00-00-00-000Z_huge.jsonl"),
		sessionFile(many),
	);
	const { entries, truncated } = readTranscript(dir, undefined, relayNotes);
	expect(truncated).toBe(true);
	expect(entries.at(-1)?.text.startsWith("2499 ")).toBe(true);
});

test("long text is clipped", () => {
	const dir = join(fixtureSessions(), "sessions", `discord_${OWNER_CHANNEL}`);
	writeFileSync(
		join(dir, "2026-09-03T00-00-00-000Z_long.jsonl"),
		sessionFile([
			{ role: "user", content: [{ type: "text", text: "y".repeat(30_000) }] },
		]),
	);
	const { entries } = readTranscript(dir, undefined, relayNotes);
	const last = entries.at(-1);
	expect(last?.text.length).toBe(20_000);
	expect(last?.text.endsWith("…")).toBe(true);
});

test("the byte budget is spent on what was read, even when the tail holds no whole line", () => {
	const dir = join(fixtureSessions(), "sessions", `discord_${OWNER_CHANNEL}`);
	// The newest file is one line longer than the budget: its tail read finds no whole line and
	// yields no entry, but 8 MB were read, so the older files must not be read at all.
	const line = JSON.stringify({
		type: "message",
		message: {
			role: "user",
			content: [{ type: "text", text: "z".repeat(9 * 1024 * 1024) }],
		},
	});
	writeFileSync(join(dir, "2026-09-06T00-00-00-000Z_huge.jsonl"), `${line}\n`);
	const { entries, truncated } = readTranscript(dir, undefined, relayNotes);
	expect(truncated).toBe(true);
	expect(entries).toEqual([]);
});

test("the list reads only the first 256 KB of an outside conversation's file to find its first message", () => {
	const sessions = join(fixtureSessions(), "sessions");
	const write = (session: string, filler: number) => {
		const dir = join(sessions, `mcp_${session}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "a.jsonl"),
			[
				sessionFile([]),
				// A system prompt before the first message, as a real session has.
				JSON.stringify({
					type: "message",
					message: { role: "system", content: "s".repeat(filler) },
				}),
				sessionFile([
					{
						role: "user",
						content: [{ type: "text", text: "Opening question" }],
					},
				]),
				'{"type":"mess',
			].join("\n"),
		);
	};
	const near = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
	const far = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
	write(near, 100 * 1024);
	write(far, 300 * 1024);
	const found = storedConversations(sessions, { excluded: none, relayNotes });
	expect(found.find((c) => c.id === near)?.firstMessage).toBe(
		"Opening question",
	);
	expect(found.find((c) => c.id === far)?.firstMessage).toBeUndefined();
});
