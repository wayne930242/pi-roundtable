import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTeam, ConversationRecord } from "pi-roundtable";
import { partial } from "pi-roundtable/testing";
import type {
	ConfigView,
	ConversationsView,
	OverviewView,
	TranscriptView,
} from "./api-types.ts";
import { api, call, MEMBER } from "./testing/console-api-host.ts";
import {
	AGENT_CHANNEL,
	fixtureSessions,
	GROUP_CHANNEL,
	HIDDEN_CHANNEL,
	OUTSIDE_SESSION,
	OWNER_CHANNEL,
	sessionFile,
} from "./testing/fixtures.ts";

describe("config", () => {
	test("tells the page its title, panes, and the host's time zone", async () => {
		const { body } = await call<ConfigView>(api().api, "config");
		expect(body).toEqual({
			title: "Test console",
			panes: ["overview", "conversations", "notes"],
			timeZone: "Europe/Paris",
			look: "modern",
		});
	});
});

describe("config skins", () => {
	test("hands the page the host's six skin tones, and only when the host has them", async () => {
		const skins = [
			"#fbebe0",
			"#f8e1d2",
			"#f5d8c5",
			"#f1cfb8",
			"#edc6ac",
			"#e9bf9f",
		];
		const { body } = await call<ConfigView>(
			api({ characterSkins: skins }).api,
			"config",
		);
		expect(body.characterSkins).toEqual(skins);
		const plain = await call<ConfigView>(api().api, "config");
		expect("characterSkins" in plain.body).toBe(false);
	});
});

describe("overview", () => {
	test("reports agents and groups from the team", async () => {
		const { body } = await call<OverviewView>(api().api, "overview");
		expect(body.guildId).toBe("900000000000000099");
		expect(body.agents[0]).toMatchObject({
			name: "scout",
			model: "provider/model",
			workingIn: OWNER_CHANNEL,
			waiting: 1,
			schedules: 2,
			lastActive: "2026-09-03T10:00:00.000Z",
			context: { tokens: 1200, contextWindow: 200_000 },
		});
		expect(body.groups[0]).toMatchObject({ name: "crew", members: ["Scout"] });
	});
});

describe("overview of a team without Discord", () => {
	test("a group with no channel is reported without a channelId", async () => {
		const crew = {
			name: "crew",
			displayName: "Crew",
			members: ["Scout"],
			host: "Scout",
			busy: 0,
		};
		const bare = partial<AgentTeam>({
			teamId: "local",
			guildId: "local",
			discordGuild: undefined,
			owns: () => undefined,
			status: async () => ({ agents: [], groups: [crew] }),
		});
		const { body } = await call<OverviewView>(
			api({ team: bare }).api,
			"overview",
		);
		expect(body.groups).toEqual([crew]);
	});
});

describe("overview of a team with its own id", () => {
	test("names the team by teamId, not by the deprecated guildId, when there is no Discord guild", async () => {
		const named = partial<AgentTeam>({
			teamId: "team-x",
			guildId: "deprecated-x",
			discordGuild: undefined,
			owns: () => undefined,
			status: async () => ({ agents: [], groups: [] }),
		});
		const { body } = await call<OverviewView>(
			api({ team: named }).api,
			"overview",
		);
		expect(body.guildId).toBe("team-x");
	});
});

describe("conversations", () => {
	test("lists each stored conversation with its kind, name, and busy count; hidden and foreign directories stay out", async () => {
		const { body } = await call<ConversationsView>(api().api, "conversations");
		const byKey = Object.fromEntries(body.conversations.map((c) => [c.key, c]));
		expect(Object.keys(byKey).sort()).toEqual(
			[
				`discord:${OWNER_CHANNEL}`,
				`discord:${AGENT_CHANNEL}`,
				`agentgroup:${GROUP_CHANNEL}.scout`,
				`mcp:${OUTSIDE_SESSION}`,
			].sort(),
		);
		expect(byKey[`discord:${OWNER_CHANNEL}`]).toMatchObject({
			kind: "owner",
			busy: 2,
			archives: 1,
			channel: { kind: "guild", name: "general" },
		});
		expect(byKey[`discord:${AGENT_CHANNEL}`]?.kind).toBe("agent");
		expect(byKey[`agentgroup:${GROUP_CHANNEL}.scout`]).toMatchObject({
			kind: "group",
			member: "scout",
			channel: { kind: "gone" },
		});
		expect(byKey[`mcp:${OUTSIDE_SESSION}`]).toMatchObject({
			kind: "outside",
			firstMessage: "Please summarise the report",
		});
		expect(byKey[`mcp:${OUTSIDE_SESSION}`]?.channel).toBeUndefined();
	});

	test("a channel Discord does not know is gone, and one it cannot be asked about is unknown", async () => {
		const gone = await call<ConversationsView>(api().api, "conversations");
		expect(
			gone.body.conversations.find((c) => c.id === AGENT_CHANNEL)?.channel,
		).toEqual({ kind: "gone" });
		const unknown = await call<ConversationsView>(
			api({
				channelName: async () => {
					throw new Error("reconnecting");
				},
			}).api,
			"conversations",
		);
		expect(
			unknown.body.conversations.find((c) => c.id === OWNER_CHANNEL)?.channel,
		).toEqual({ kind: "unknown" });
		const noDiscord = await call<ConversationsView>(
			api({ channelName: undefined }).api,
			"conversations",
		);
		expect(
			noDiscord.body.conversations.find((c) => c.id === OWNER_CHANNEL)?.channel,
		).toEqual({ kind: "unknown" });
	});

	test("reads a transcript, with its archives", async () => {
		const { api: instance } = api();
		const live = await call<TranscriptView>(
			instance,
			`conversations/${encodeURIComponent(`discord:${OWNER_CHANNEL}`)}`,
		);
		expect(live.status).toBe(200);
		expect(live.body.entries.map((e) => e.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"assistant",
		]);
		expect(live.body.archives).toEqual(["2026-08-30T08-00-00.000Z"]);
		expect(live.body.archive).toBeUndefined();
		expect(live.body.conversation.kind).toBe("owner");
		const archived = await call<TranscriptView>(
			instance,
			`conversations/${encodeURIComponent(`discord:${OWNER_CHANNEL}`)}?archive=2026-08-30T08-00-00.000Z`,
		);
		expect(archived.body.archive).toBe("2026-08-30T08-00-00.000Z");
		expect(archived.body.entries.map((e) => e.text)).toEqual([
			"An older question",
			"An older answer",
		]);
	});

	test("refuses a hidden conversation, an unknown one, a bad key, and an archive that is not listed", async () => {
		const { api: instance } = api();
		const read = (key: string, query = "") =>
			call<{ error: string }>(
				instance,
				`conversations/${encodeURIComponent(key)}${query}`,
			);
		expect((await read(`discord:${HIDDEN_CHANNEL}`)).status).toBe(404);
		expect((await read("discord:900000000000000077")).status).toBe(404);
		expect((await read("discord:../../etc/passwd")).status).toBe(404);
		expect((await read("mcp:..%2F..")).status).toBe(404);
		const bad = await read(`discord:${OWNER_CHANNEL}`, "?archive=../..");
		expect(bad.status).toBe(404);
		expect(bad.body.error).toBe("There is no such archive.");
	});
});

describe("registered conversations", () => {
	const record = (
		key: string,
		change: Partial<ConversationRecord> = {},
	): ConversationRecord => ({
		key: key as ConversationRecord["key"],
		surface: key.slice(0, key.indexOf(":")),
		kind: "study",
		visibility: "private",
		principalId: "oidc:aXNz:ada",
		createdAt: new Date("2026-09-05T09:00:00.000Z"),
		lastActiveAt: new Date("2026-09-05T09:30:00.000Z"),
		...change,
	});
	const shared = (key: string): ConversationRecord => {
		const { principalId: _private, ...rest } = record(key);
		return { ...rest, visibility: "shared" };
	};
	/** The fixture's sessions, a web chat's among them, and a registry that knows the web chats. */
	function registered() {
		const dataDir = fixtureSessions();
		const dir = join(dataDir, "sessions", "web_chat-1");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "w.jsonl"),
			sessionFile([
				{ role: "user", content: [{ type: "text", text: "What is a group?" }] },
				{
					role: "assistant",
					content: [{ type: "text", text: "A set with an operation." }],
				},
			]),
		);
		const records = [
			record("web:chat-1", { title: "Algebra" }),
			// Recorded, but its first turn left no session file: nothing to read.
			record("web:chat-2"),
			// A legacy key a plugin also recorded keeps its own kind; shared, it is no one's.
			shared(`discord:${OWNER_CHANNEL}`),
		];
		return api({
			sessionsDir: join(dataDir, "sessions"),
			registry: {
				list: async () => records,
				get: async (key) => records.find((r) => r.key === key),
			},
		}).api;
	}

	test("the registry's conversations are listed beside the ones found on disk, with their title", async () => {
		const { body } = await call<ConversationsView>(
			registered(),
			"conversations",
		);
		const byKey = Object.fromEntries(body.conversations.map((c) => [c.key, c]));
		expect(Object.keys(byKey).sort()).toEqual(
			[
				`discord:${OWNER_CHANNEL}`,
				`discord:${AGENT_CHANNEL}`,
				`agentgroup:${GROUP_CHANNEL}.scout`,
				`mcp:${OUTSIDE_SESSION}`,
				"web:chat-1",
			].sort(),
		);
		expect(byKey["web:chat-1"]).toMatchObject({
			kind: "plugin",
			id: "chat-1",
			title: "Algebra",
			firstMessage: "What is a group?",
			archives: 0,
			busy: 0,
		});
		expect(byKey["web:chat-1"]?.channel).toBeUndefined();
		expect(byKey[`discord:${OWNER_CHANNEL}`]?.kind).toBe("owner");
	});

	test("a conversation the registry records shows whose it is by their name, and whether it is shared", async () => {
		const { body } = await call<ConversationsView>(
			registered(),
			"conversations",
		);
		const byKey = Object.fromEntries(body.conversations.map((c) => [c.key, c]));
		expect(byKey["web:chat-1"]).toMatchObject({
			visibility: "private",
			principal: { id: MEMBER.id, name: "Ada" },
		});
		expect(byKey[`discord:${OWNER_CHANNEL}`]?.visibility).toBe("shared");
		expect(byKey[`discord:${OWNER_CHANNEL}`]?.principal).toBeUndefined();
		// Conversations the registry does not know say neither.
		expect(byKey[`mcp:${OUTSIDE_SESSION}`]?.visibility).toBeUndefined();
		expect(byKey[`mcp:${OUTSIDE_SESSION}`]?.principal).toBeUndefined();
		const transcript = await call<TranscriptView>(
			registered(),
			`conversations/${encodeURIComponent("web:chat-1")}`,
		);
		expect(transcript.body.conversation.principal).toEqual({
			id: MEMBER.id,
			name: "Ada",
		});
	});

	test("a principal the host no longer knows is shown by their id", async () => {
		const instance = api({
			sessionsDir: `${fixtureSessions()}/sessions`,
			registry: {
				list: async () => [
					record(`mcp:${OUTSIDE_SESSION}`, { principalId: "p_gone" }),
				],
				get: async () => undefined,
			},
		}).api;
		const { body } = await call<ConversationsView>(instance, "conversations");
		expect(
			body.conversations.find((c) => c.key === `mcp:${OUTSIDE_SESSION}`)
				?.principal,
		).toEqual({ id: "p_gone", name: "p_gone" });
	});

	test("a registered conversation's transcript is read from its own directory; an unregistered key is not", async () => {
		const instance = registered();
		const live = await call<TranscriptView>(
			instance,
			`conversations/${encodeURIComponent("web:chat-1")}`,
		);
		expect(live.status).toBe(200);
		expect(live.body.conversation.kind).toBe("plugin");
		expect(live.body.entries.map((e) => e.text)).toEqual([
			"What is a group?",
			"A set with an operation.",
		]);
		const unknown = await call<{ error: string }>(
			instance,
			`conversations/${encodeURIComponent("web:chat-9")}`,
		);
		expect(unknown.status).toBe(404);
		const unread = await call<{ error: string }>(
			instance,
			`conversations/${encodeURIComponent("web:chat-2")}`,
		);
		expect(unread.status).toBe(404);
	});
});
