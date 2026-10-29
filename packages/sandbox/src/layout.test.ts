import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
	channelStateDir,
	channelWorkspaceDir,
	encodeHistory,
	guildWorkspaceDir,
	HISTORY_ENTRY_BYTES,
	HISTORY_FILE,
	HISTORY_MAX_ENTRIES,
	historyFilePath,
	userHistoryContent,
} from "./index.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

test("the on-disk layout under workspaceRoot is the one the spec fixes", () => {
	const root = "/srv/work";
	expect(guildWorkspaceDir(root, "discord", "900000000000000001")).toBe(
		join(root, `guild-${sha("guild\0discord:900000000000000001")}`),
	);
	expect(channelStateDir(root, "discord:900000000000000003")).toBe(
		join(root, `state-${sha("state\0discord:900000000000000003")}`),
	);
	// Today's per-channel workspaces keep their place.
	expect(channelWorkspaceDir(root, "discord:1")).toBe(
		join(root, sha("discord:1")),
	);
	expect(historyFilePath(channelStateDir(root, "discord:1"))).toBe(
		join(channelStateDir(root, "discord:1"), HISTORY_FILE),
	);
	expect(HISTORY_FILE).toBe("history.json");
});

test("a guild and a channel with the same id never share a directory", () => {
	const root = "/srv/work";
	const dirs = new Set([
		guildWorkspaceDir(root, "discord", "1"),
		guildWorkspaceDir(root, "other", "1"),
		channelStateDir(root, "discord:1"),
		channelWorkspaceDir(root, "discord:1"),
	]);
	expect(dirs.size).toBe(4);
});

test("the history encoder writes what the worker reads and refuses what it would reject", () => {
	const user = userHistoryContent(
		{ id: "42", name: "\u963f\u99a8" },
		"\u4f60\u597d",
	);
	expect(user).toBe(
		'{"speaker":{"id":"42","name":"\u963f\u99a8"},"message":"\u4f60\u597d"}',
	);
	expect(
		JSON.parse(
			encodeHistory([
				{ role: "user", content: user },
				{ role: "assistant", content: "\u54c8\u56c9" },
			]),
		),
	).toEqual([
		{ role: "user", content: user },
		{ role: "assistant", content: "\u54c8\u56c9" },
	]);
	expect(HISTORY_MAX_ENTRIES).toBe(20);
	expect(HISTORY_ENTRY_BYTES).toBe(8192);
	expect(() =>
		encodeHistory(
			Array.from({ length: 21 }, () => ({
				role: "user" as const,
				content: "x",
			})),
		),
	).toThrow("20");
	expect(() =>
		encodeHistory([{ role: "user", content: "\u5b57".repeat(2731) }]),
	).toThrow("8192");
	expect(
		encodeHistory([{ role: "user", content: "\u5b57".repeat(2730) }]),
	).toContain("\u5b57");
	expect(() =>
		encodeHistory([{ role: "system" as never, content: "x" }]),
	).toThrow();
	expect(() =>
		encodeHistory([{ role: "user", content: 3 as never }]),
	).toThrow();
});
