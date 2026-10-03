import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	archiveNames,
	conversationFiles,
	readTranscript,
	storedConversations,
} from "./conversations.ts";
import { fixtureSessions, OWNER_CHANNEL } from "./testing/fixtures.ts";

test("session directory/file/archive symlinks never read outside stored conversations", () => {
	const root = fixtureSessions();
	const privateDir = join(root, "private");
	mkdirSync(privateDir);
	const privateFile = join(privateDir, "private.jsonl");
	writeFileSync(
		privateFile,
		`${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Private outside file" }] } })}\n`,
	);
	const sessions = join(root, "sessions");
	const linkDir = join(sessions, "discord_900000000000000088");
	symlinkSync(privateDir, linkDir);
	expect(conversationFiles(linkDir)).toBeUndefined();
	expect(
		storedConversations(sessions, {
			excluded: () => false,
			relayNotes: [],
		}).some((c) => c.id === "900000000000000088"),
	).toBe(false);
	const owner = join(sessions, `discord_${OWNER_CHANNEL}`);
	symlinkSync(privateFile, join(owner, "linked.jsonl"));
	symlinkSync(privateDir, join(owner, "archive", "linked"));
	expect(archiveNames(owner)).not.toContain("linked");
	expect(JSON.stringify(readTranscript(owner, undefined, []))).not.toContain(
		"Private outside file",
	);
	const newDir = join(sessions, "discord_900000000000000089");
	mkdirSync(newDir);
	symlinkSync(privateDir, join(newDir, "archive"));
	expect(conversationFiles(newDir)).toEqual({ liveBytes: 0, archives: 0 });
	expect(archiveNames(newDir)).toEqual([]);
});
