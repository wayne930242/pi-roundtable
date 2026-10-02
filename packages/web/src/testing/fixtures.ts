import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { Memory, MemoryKind, SpeakerMemory } from "pi-roundtable";
import { MemoryError } from "pi-roundtable";
import { DEFAULT_RELAY_NOTE } from "../options.ts";

export const TEAM = "team.example.test";
export const AUDIENCE = "aud-for-tests";
export const OWNER_EMAIL = "owner@example.test";
export const ORIGIN = "https://console.example.test";

/** Ids that no real Discord channel has (they start with 9). */
export const OWNER_CHANNEL = "900000000000000001";
export const AGENT_CHANNEL = "900000000000000002";
export const GROUP_CHANNEL = "900000000000000003";
export const HIDDEN_CHANNEL = "900000000000000004";
export const OUTSIDE_SESSION = "3f9c1a2e-5b7d-4c8e-9a1f-0123456789ab";

/** A signing key and the key set that vouches for it, as the Access team's published keys would. */
export async function accessKeys() {
	const team = await generateKeyPair("RS256");
	const stranger = await generateKeyPair("RS256");
	const jwk = { ...(await exportJWK(team.publicKey)), kid: "k1", alg: "RS256" };
	const keys = createLocalJWKSet({ keys: [jwk] });
	const sign = (
		claims: { email?: string; aud?: string; iss?: string } = {},
		key = team.privateKey,
	) =>
		new SignJWT({ email: claims.email ?? OWNER_EMAIL })
			.setProtectedHeader({ alg: "RS256", kid: "k1" })
			.setIssuer(claims.iss ?? `https://${TEAM}`)
			.setAudience(claims.aud ?? AUDIENCE)
			.setIssuedAt()
			.setExpirationTime("1h")
			.sign(key);
	return { keys, sign, strangerKey: stranger.privateKey };
}

const sessionLine = (value: unknown) => `${JSON.stringify(value)}\n`;

/** A Pi session file with a header and the given messages. */
export function sessionFile(
	messages: { role: string; content: unknown; [key: string]: unknown }[],
	start = "2026-09-01T10:00:00.000Z",
): string {
	return [
		sessionLine({ type: "session", version: 3, id: "s", timestamp: start }),
		...messages.map((message, index) =>
			sessionLine({
				type: "message",
				id: `m${index}`,
				timestamp: new Date(
					Date.parse(start) + (index + 1) * 1000,
				).toISOString(),
				message,
			}),
		),
	].join("");
}

const text = (value: string) => [{ type: "text", text: value }];

/** Writes `contents` at `dir/<name>` with the given modification time. */
function put(dir: string, name: string, contents: string, mtime?: Date) {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, contents);
	if (mtime) utimesSync(path, mtime, mtime);
}

/**
 * A sessions directory with one conversation of each kind: an owner channel with an archive, an
 * agent channel, a group member's conversation, a hidden channel, an outside-agent conversation whose first
 * message carries the relay note, and a directory the console must ignore.
 */
export function fixtureSessions(): string {
	const dataDir = mkdtempSync(join(tmpdir(), "web-console-"));
	const sessions = join(dataDir, "sessions");
	const owner = join(sessions, `discord_${OWNER_CHANNEL}`);
	put(
		owner,
		"2026-09-02T10-00-00-000Z_live.jsonl",
		sessionFile(
			[
				{ role: "system", content: "SYSTEM PROMPT NOT SHOWN" },
				{ role: "user", content: text("What is on my calendar?") },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "private reasoning" },
						{ type: "text", text: "Let me check." },
						{
							type: "toolCall",
							id: "c1",
							name: "calendar_list",
							arguments: { day: "today" },
						},
					],
				},
				{
					role: "toolResult",
					toolCallId: "c1",
					toolName: "calendar_list",
					content: text("09:00 stand-up"),
				},
				{ role: "assistant", content: text("You have a stand-up at 09:00.") },
			],
			"2026-09-02T10:00:00.000Z",
		),
		new Date("2026-09-02T10:05:00.000Z"),
	);
	put(
		join(owner, "archive", "2026-08-30T08-00-00.000Z"),
		"2026-08-30T07-00-00-000Z_old.jsonl",
		sessionFile([
			{ role: "user", content: text("An older question") },
			{ role: "assistant", content: text("An older answer") },
		]),
		new Date("2026-08-30T08:00:00.000Z"),
	);
	put(
		join(sessions, `discord_${AGENT_CHANNEL}`),
		"a.jsonl",
		sessionFile([{ role: "user", content: text("Agent task") }]),
		new Date("2026-09-03T10:00:00.000Z"),
	);
	// The core keeps a group member's conversation under `agentgroup:<channel>.<agent>`.
	put(
		join(sessions, `agentgroup_${GROUP_CHANNEL}_scout`),
		"g.jsonl",
		sessionFile([{ role: "user", content: text("Group topic") }]),
		new Date("2026-09-01T10:00:00.000Z"),
	);
	put(
		join(sessions, `discord_${HIDDEN_CHANNEL}`),
		"h.jsonl",
		sessionFile([{ role: "user", content: text("Hidden") }]),
		new Date("2026-08-01T10:00:00.000Z"),
	);
	put(
		join(sessions, `mcp_${OUTSIDE_SESSION}`),
		"o.jsonl",
		sessionFile(
			[
				{
					role: "user",
					content: text(`${DEFAULT_RELAY_NOTE}\nPlease summarise the report`),
				},
				{ role: "assistant", content: text("Here is the summary.") },
			],
			"2026-09-04T09:00:00.000Z",
		),
		new Date("2026-09-04T09:10:00.000Z"),
	);
	put(join(sessions, "not-a-conversation"), "x.jsonl", "{}\n");
	put(join(sessions, "discord_12"), "x.jsonl", "{}\n");
	return dataDir;
}

/** The owner's memory in memory, with the store's validation and error messages. */
export function fakeMemory(initial: Omit<Memory, "id">[] = []): SpeakerMemory {
	const rows: Memory[] = initial.map((row, index) => ({
		...row,
		id: index + 1,
	}));
	let nextId = rows.length + 1;
	const check = (fact: string, kind: MemoryKind, eventDate?: string) => {
		if (!fact.trim()) throw new MemoryError("a memory fact cannot be empty");
		if (kind === "event" && !/^\d{4}-\d{2}-\d{2}$/.test(eventDate ?? ""))
			throw new MemoryError("an event needs its date as YYYY-MM-DD");
		if (kind !== "event" && eventDate)
			throw new MemoryError("only an event has a date");
	};
	return {
		list: async () => [...rows],
		forPrompt: async () => ({ core: [], events: [] }) as never,
		search: async (query) =>
			rows.filter((row) =>
				query
					.toLowerCase()
					.split(/\s+/)
					.some((term) => row.fact.toLowerCase().includes(term)),
			),
		add: async (fact, kind = "note", eventDate) => {
			check(fact, kind, eventDate);
			const row: Memory = {
				id: nextId++,
				kind,
				fact,
				eventDate: eventDate ?? null,
			};
			rows.push(row);
			return row;
		},
		update: async (id, change) => {
			const row = rows.find((candidate) => candidate.id === id);
			if (!row) return undefined;
			check(change.fact, change.kind, change.eventDate);
			Object.assign(row, {
				fact: change.fact,
				kind: change.kind,
				eventDate: change.eventDate ?? null,
			});
			return row;
		},
		removeById: async (id) => {
			const index = rows.findIndex((row) => row.id === id);
			if (index < 0) return false;
			rows.splice(index, 1);
			return true;
		},
		remove: async () => [],
	};
}
