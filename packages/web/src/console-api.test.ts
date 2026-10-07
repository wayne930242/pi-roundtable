import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTeam, ConversationRecord } from "pi-roundtable";
import { partial, recordingLogger, silentLogger } from "pi-roundtable/testing";
import type {
	ConfigView,
	ConversationsView,
	NoteView,
	OverviewView,
	TranscriptView,
} from "./api-types.ts";
import { ConsoleApi, type ConsolePorts } from "./console-api.ts";
import { DEFAULT_RELAY_NOTE } from "./options.ts";
import {
	AGENT_CHANNEL,
	fakeMemory,
	fixtureSessions,
	GROUP_CHANNEL,
	HIDDEN_CHANNEL,
	OUTSIDE_SESSION,
	OWNER_CHANNEL,
	sessionFile,
} from "./testing/fixtures.ts";

const team = partial<Pick<AgentTeam, "status" | "owns" | "guildId">>({
	guildId: "900000000000000099",
	owns: (key) =>
		key === `discord:${AGENT_CHANNEL}`
			? "agent"
			: key === `discord:${GROUP_CHANNEL}`
				? "group"
				: undefined,
	status: async () => ({
		agents: [
			{
				name: "scout",
				displayName: "Scout",
				channelId: AGENT_CHANNEL,
				model: "provider/model",
				thinking: "auto" as never,
				workingIn: OWNER_CHANNEL,
				waiting: 1,
				context: { tokens: 1200, contextWindow: 200_000 },
				lastActive: new Date("2026-09-03T10:00:00.000Z"),
				schedules: 2,
			},
		],
		groups: [
			{
				name: "crew",
				displayName: "Crew",
				channelId: GROUP_CHANNEL,
				members: ["Scout"],
				host: "Scout",
				busy: 0,
			},
		],
	}),
});

function api(change: Partial<ConsolePorts> = {}) {
	const changes: number[] = [];
	const recorder = recordingLogger();
	const instance = new ConsoleApi({
		title: "Test console",
		timeZone: "Europe/Paris",
		panes: ["overview", "conversations", "notes"],
		sessionsDir: `${fixtureSessions()}/sessions`,
		team,
		queue: { size: (key) => (key === `discord:${OWNER_CHANNEL}` ? 2 : 0) },
		channelName: async (id) =>
			id === OWNER_CHANNEL
				? {
						kind: "guild",
						name: "general",
						guild: "Home",
						guildId: "900000000000000099",
					}
				: undefined,
		memory: fakeMemory([
			{ kind: "core", fact: "Likes tea", eventDate: null },
			{ kind: "event", fact: "Trip", eventDate: "2026-12-01" },
		]),
		exclude: (key) => key === `discord:${HIDDEN_CHANNEL}`,
		relayNotes: [DEFAULT_RELAY_NOTE],
		changed: () => changes.push(Date.now()),
		logger: recorder.logger,
		...change,
	});
	return { api: instance, changes, logger: recorder };
}

const call = async <T>(
	instance: ConsoleApi,
	path: string,
	init: RequestInit = {},
): Promise<{ status: number; body: T }> => {
	const response = await instance.handle(
		new Request(`http://console/console/api/${path}`, init),
		path.split("?")[0] ?? "",
	);
	return { status: response.status, body: (await response.json()) as T };
};

const send = (method: string, body: unknown): RequestInit => ({
	method,
	body: JSON.stringify(body),
	headers: { "content-type": "application/json" },
});

describe("config", () => {
	test("tells the page its title, panes, and the host's time zone", async () => {
		const { body } = await call<ConfigView>(api().api, "config");
		expect(body).toEqual({
			title: "Test console",
			panes: ["overview", "conversations", "notes"],
			timeZone: "Europe/Paris",
		});
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
			// A legacy key a plugin also recorded keeps its own kind.
			record(`discord:${OWNER_CHANNEL}`, { visibility: "shared" }),
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

describe("notes", () => {
	test("lists, searches, adds, edits, and deletes, and tells the page each time", async () => {
		const { api: instance, changes } = api();
		const listed = await call<NoteView[]>(instance, "notes");
		expect(listed.body.map((n) => n.fact)).toEqual(["Likes tea", "Trip"]);
		const found = await call<NoteView[]>(instance, "notes?q=trip");
		expect(found.body.map((n) => n.fact)).toEqual(["Trip"]);
		const added = await call<NoteView>(
			instance,
			"notes",
			send("POST", { fact: "Walks daily", kind: "note" }),
		);
		expect(added.status).toBe(201);
		expect(added.body).toMatchObject({ fact: "Walks daily", kind: "note" });
		const edited = await call<NoteView>(
			instance,
			`notes/${added.body.id}`,
			send("PATCH", { fact: "Walks twice daily", kind: "note" }),
		);
		expect(edited.body.fact).toBe("Walks twice daily");
		const removed = await call<{ deleted: number }>(
			instance,
			`notes/${added.body.id}`,
			{
				method: "DELETE",
			},
		);
		expect(removed.body).toEqual({ deleted: added.body.id });
		expect(changes).toHaveLength(3);
		expect((await call<NoteView[]>(instance, "notes")).body).toHaveLength(2);
	});

	test("refuses what the memory tools refuse, with the reason, and saves nothing", async () => {
		const { api: instance, changes } = api();
		const refused = async (body: unknown) =>
			call<{ error: string }>(instance, "notes", send("POST", body));
		expect((await refused({ fact: " ", kind: "note" })).body.error).toBe(
			"The note cannot be empty.",
		);
		expect((await refused({ fact: "x", kind: "event" })).body.error).toBe(
			"An event needs its date as YYYY-MM-DD.",
		);
		expect(
			(await refused({ fact: "x", kind: "note", eventDate: "2026-01-01" })).body
				.error,
		).toBe("Only an event has a date.");
		expect(
			(await refused({ fact: "x", kind: "note", eventDate: 5 })).status,
		).toBe(400);
		expect((await refused("nope")).status).toBe(400);
		expect(changes).toEqual([]);
		expect((await call<NoteView[]>(instance, "notes")).body).toHaveLength(2);
	});

	test("answers 404 for an unknown note and 405 for a method it does not take", async () => {
		const { api: instance } = api();
		expect(
			(
				await call(
					instance,
					"notes/99",
					send("PATCH", { fact: "x", kind: "note" }),
				)
			).status,
		).toBe(404);
		expect(
			(await call(instance, "notes/99", { method: "DELETE" })).status,
		).toBe(404);
		expect(
			(await call(instance, "notes/abc", { method: "DELETE" })).status,
		).toBe(404);
		expect((await call(instance, "notes", { method: "PUT" })).status).toBe(405);
	});

	test("refuses a body over 64 KB", async () => {
		const { api: instance } = api();
		const big = await call<{ error: string }>(
			instance,
			"notes",
			send("POST", { fact: "x".repeat(70_000), kind: "note" }),
		);
		expect(big.status).toBe(413);
	});
});

describe("body limit", () => {
	test("refuses a body that streams past 64 KB without declaring its length", async () => {
		const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < 6; i++) controller.enqueue(chunk);
				controller.close();
			},
		});
		const request = new Request("http://console/console/api/notes", {
			method: "POST",
			body,
			duplex: "half",
		});
		const response = await api().api.handle(request, "notes");
		expect(response.status).toBe(413);
	});
});

describe("panes and errors", () => {
	test("a pane that is not served answers 404", async () => {
		const { api: instance } = api({ panes: ["conversations"] });
		expect((await call(instance, "overview")).status).toBe(404);
		expect((await call(instance, "notes")).status).toBe(404);
		expect((await call(instance, "conversations")).status).toBe(200);
	});

	test("an unknown path answers 404 without repeating it", async () => {
		const response = await call<{ error: string }>(
			api().api,
			"secret-looking/path?token=abc",
		);
		expect(response.status).toBe(404);
		expect(JSON.stringify(response.body)).not.toContain("secret-looking");
		expect(JSON.stringify(response.body)).not.toContain("token");
	});

	test("a failure answers 500 with a fixed message, and logs neither the URL nor the headers", async () => {
		const { api: instance, logger } = api({
			memory: {
				...fakeMemory(),
				list: async () => {
					throw new Error("boom");
				},
			},
		});
		const response = await instance.handle(
			new Request("http://console/console/api/notes?note=hunter2", {
				headers: { authorization: "Bearer very-secret", cookie: "sid=abc" },
			}),
			"notes",
		);
		expect(response.status).toBe(500);
		const text = await response.text();
		expect(text).toBe(
			JSON.stringify({ error: "The console could not complete the request." }),
		);
		const logged = JSON.stringify(logger.lines, (_key, value) =>
			value instanceof Error ? value.message : value,
		);
		expect(logged).not.toContain("hunter2");
		expect(logged).not.toContain("very-secret");
		expect(logged).not.toContain("sid=abc");
		expect(logged).toContain("console api failed");
	});

	test("every response says not to cache it", async () => {
		const response = await api().api.handle(
			new Request("http://console/console/api/config"),
			"config",
		);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});
});

test("silentLogger is accepted as the logger", () => {
	expect(() => api({ logger: silentLogger() })).not.toThrow();
});
