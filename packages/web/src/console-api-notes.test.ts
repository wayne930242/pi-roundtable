import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationRecord } from "pi-roundtable";
import { silentLogger } from "pi-roundtable/testing";
import type {
	ConfigView,
	ConversationsView,
	NoteView,
	PrincipalsView,
	TranscriptView,
} from "./api-types.ts";
import type { ConsolePorts } from "./console-api.ts";
import {
	AS_OWNER,
	api,
	call,
	MEMBER,
	OWNER,
	RETIRED,
	SECOND,
	send,
	visitorOf,
} from "./testing/console-api-host.ts";
import {
	fakeMemory,
	fixtureSessions,
	OWNER_CHANNEL,
	sessionFile,
} from "./testing/fixtures.ts";
import type { Visitor } from "./visitors.ts";

describe("notes", () => {
	test("are the visitor's own unless the page asks for someone else's", async () => {
		const { api: instance } = api();
		const facts = async (path: string, visitor = AS_OWNER) =>
			(await call<NoteView[]>(instance, path, {}, visitor)).body.map(
				(n) => n.fact,
			);
		expect(await facts("notes")).toEqual(["Likes tea", "Trip"]);
		expect(await facts("notes", visitorOf(SECOND))).toEqual(["Likes coffee"]);
		expect(
			await facts(`notes?principal=${encodeURIComponent(SECOND.id)}`),
		).toEqual(["Likes coffee"]);
		expect(
			await facts(
				`notes?principal=${encodeURIComponent(OWNER.id)}&q=tea`,
				visitorOf(SECOND),
			),
		).toEqual(["Likes tea"]);
	});

	test("adds, edits, and deletes in the chosen person's notes only", async () => {
		const { api: instance } = api();
		const theirs = `principal=${encodeURIComponent(SECOND.id)}`;
		const added = await call<NoteView>(
			instance,
			`notes?${theirs}`,
			send("POST", { fact: "Runs", kind: "note" }),
		);
		expect(added.status).toBe(201);
		const edited = await call<NoteView>(
			instance,
			`notes/${added.body.id}?${theirs}`,
			send("PATCH", { fact: "Runs far", kind: "note" }),
		);
		expect(edited.body.fact).toBe("Runs far");
		expect(
			(await call<NoteView[]>(instance, "notes")).body.map((n) => n.fact),
		).toEqual(["Likes tea", "Trip"]);
		const removed = await call(instance, `notes/${added.body.id}?${theirs}`, {
			method: "DELETE",
		});
		expect(removed.status).toBe(200);
		expect(
			(await call<NoteView[]>(instance, `notes?${theirs}`)).body.map(
				(n) => n.fact,
			),
		).toEqual(["Likes coffee"]);
	});

	test("refuses a person the host does not know, and the host's own principal", async () => {
		const { api: instance } = api();
		for (const id of ["nobody", "system", ""]) {
			const response = await call<{ error: string }>(
				instance,
				`notes?principal=${encodeURIComponent(id)}`,
			);
			expect(response.status).toBe(404);
			expect(response.body.error).toBe("There is no such person.");
		}
	});

	test("lists the people whose notes the pane can show, the visitor first", async () => {
		const { api: instance } = api();
		const { body } = await call<PrincipalsView>(
			instance,
			"principals",
			{},
			visitorOf(SECOND),
		);
		expect(body).toEqual({
			self: SECOND.id,
			principals: [
				{ id: SECOND.id, name: "Bea" },
				{ id: OWNER.id, name: "Owner" },
				{ id: MEMBER.id, name: "Ada" },
				{ id: RETIRED.id, name: "Gus", disabled: true },
			],
		});
		expect(
			(await call(api({ panes: ["conversations"] }).api, "principals")).status,
		).toBe(404);
	});

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
		const response = await api().api.handle(request, "notes", AS_OWNER);
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
			memoryOf: () => ({
				...fakeMemory(),
				list: async () => {
					throw new Error("boom");
				},
			}),
		});
		const response = await instance.handle(
			new Request("http://console/console/api/notes?note=hunter2", {
				headers: { authorization: "Bearer very-secret", cookie: "sid=abc" },
			}),
			"notes",
			AS_OWNER,
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
			AS_OWNER,
		);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});
});

test("silentLogger is accepted as the logger", () => {
	expect(() => api({ logger: silentLogger() })).not.toThrow();
});

describe("a member of a host that admits more than its owners", () => {
	const AS_MEMBER: Visitor = {
		principal: { id: MEMBER.id, displayName: "Ada", disabled: false },
		tier: "member",
		speakerId: "oidc:aXNz:ada",
		roles: [],
	};
	const AS_ADMIN: Visitor = { ...AS_MEMBER, tier: "admin" };
	const record = (
		key: string,
		over: Partial<ConversationRecord> = {},
	): ConversationRecord => ({
		key: key as ConversationRecord["key"],
		surface: "web",
		kind: "study",
		visibility: "private",
		principalId: MEMBER.id,
		createdAt: new Date("2026-09-05T09:00:00.000Z"),
		lastActiveAt: new Date("2026-09-05T09:30:00.000Z"),
		...over,
	});

	function hosted(change: Partial<ConsolePorts> = {}) {
		const dataDir = fixtureSessions();
		for (const [dir, text] of [
			["web_mine", "My own question"],
			["web_hers", "Bea's private question"],
			["web_team", "A shared question"],
			["web_hidden", "A hidden question"],
		] as const) {
			mkdirSync(join(dataDir, "sessions", dir), { recursive: true });
			writeFileSync(
				join(dataDir, "sessions", dir, "w.jsonl"),
				sessionFile([{ role: "user", content: [{ type: "text", text }] }]),
			);
		}
		const records = [
			record("web:mine"),
			record("web:hers", { principalId: SECOND.id }),
			record("web:team", { visibility: "shared" }),
			record("web:hidden"),
		];
		const asked: unknown[] = [];
		const excluded: [string, string | undefined][] = [];
		return {
			asked,
			excluded,
			...api({
				sessionsDir: join(dataDir, "sessions"),
				panes: ["overview", "conversations", "notes"],
				tierPanes: {
					owner: ["overview", "conversations", "notes"],
					admin: ["conversations", "notes"],
					member: ["conversations", "notes"],
				},
				access: {
					push: { tiers: ["owner", "member"] },
					gate: async () => [],
				},
				hosted: async () => ({ pages: [], kinds: [] }),
				registry: {
					list: async (filter?: { principal?: string }) => {
						asked.push(filter);
						return filter?.principal
							? records.filter((r) => r.principalId === filter.principal)
							: records;
					},
					get: async (key) => records.find((r) => r.key === key),
				},
				exclude: (key, found) => {
					excluded.push([key, found?.principalId]);
					return key === "web:hidden";
				},
				...change,
			}),
		};
	}

	test("the config names the member's tier and panes, and who may get push", async () => {
		const { api: instance } = hosted();
		const { body } = await call<ConfigView & { tier?: string; push?: unknown }>(
			instance,
			"config",
			{},
			AS_MEMBER,
		);
		expect(body).toMatchObject({
			panes: ["conversations", "notes"],
			tier: "member",
			push: { tiers: ["owner", "member"] },
		});
		// The owner's list is the one the host configured, with the same extras.
		const owner = await call<ConfigView>(instance, "config");
		expect(owner.body.panes).toEqual(["overview", "conversations", "notes"]);
	});

	test("a member lists only their own private conversations, found by the registry, minus what exclude refuses", async () => {
		const { api: instance, asked } = hosted();
		const { body } = await call<ConversationsView>(
			instance,
			"conversations",
			{},
			AS_MEMBER,
		);
		expect(body.conversations.map((c) => c.key)).toEqual(["web:mine"]);
		expect(asked).toEqual([{ principal: MEMBER.id }]);
		// The owner still sees every conversation the registry holds but the hidden one.
		const all = await call<ConversationsView>(instance, "conversations");
		expect(all.body.conversations.map((c) => c.key)).toContain("web:team");
		expect(all.body.conversations.map((c) => c.key)).not.toContain(
			"web:hidden",
		);
	});

	test("exclude is asked with the key and the registry's record, on every list and every transcript read", async () => {
		const { api: instance, excluded } = hosted();
		await call(instance, "conversations", {}, AS_MEMBER);
		expect(excluded).toContainEqual(["web:mine", MEMBER.id]);
		excluded.length = 0;
		const read = (key: string) =>
			call<TranscriptView>(
				instance,
				`conversations/${encodeURIComponent(key)}`,
				{},
				AS_MEMBER,
			);
		expect((await read("web:mine")).status).toBe(200);
		expect(excluded).toContainEqual(["web:mine", MEMBER.id]);
	});

	test("a member reads their own transcript and no one else's, shared ones and hidden ones included", async () => {
		const { api: instance } = hosted();
		const read = async (key: string, as = AS_MEMBER) =>
			(
				await call<TranscriptView>(
					instance,
					`conversations/${encodeURIComponent(key)}`,
					{},
					as,
				)
			).status;
		expect(await read("web:mine")).toBe(200);
		expect(await read("web:hers")).toBe(404);
		expect(await read("web:team")).toBe(404);
		expect(await read("web:hidden")).toBe(404);
		expect(await read(`discord:${OWNER_CHANNEL}`)).toBe(404);
		// An admin has the member's views, not the owner's.
		expect(await read("web:hers", AS_ADMIN)).toBe(404);
		expect(await read("web:hers", AS_OWNER)).toBe(200);
	});

	test("a pane the tier is not served answers 404, and the overview is the owners'", async () => {
		const { api: instance } = hosted();
		for (const path of ["overview", "dashboard", "skills", "connectors"])
			expect((await call(instance, path, {}, AS_MEMBER)).status).toBe(404);
		expect((await call(instance, "overview")).status).toBe(200);
	});

	test("a member's notes are their own: the list of principals is themselves, and another's are refused", async () => {
		const { api: instance } = hosted();
		const people = await call<PrincipalsView>(
			instance,
			"principals",
			{},
			AS_MEMBER,
		);
		expect(people.body).toEqual({
			self: MEMBER.id,
			principals: [{ id: MEMBER.id, name: "Ada" }],
		});
		const own = await call<NoteView[]>(instance, "notes", {}, AS_MEMBER);
		expect(own.status).toBe(200);
		const other = await call(
			instance,
			`notes?principal=${encodeURIComponent(OWNER.id)}`,
			{},
			AS_MEMBER,
		);
		expect(other.status).toBe(403);
		const self = await call(
			instance,
			`notes?principal=${encodeURIComponent(MEMBER.id)}`,
			{},
			AS_MEMBER,
		);
		expect(self.status).toBe(200);
	});

	test("without memory the notes pane is not served, to a member either", async () => {
		const { api: instance } = hosted({
			memoryOf: undefined as never,
			tierPanes: {
				owner: ["conversations"],
				admin: ["conversations"],
				member: ["conversations"],
			},
		});
		for (const visitor of [AS_MEMBER, AS_OWNER])
			expect((await call(instance, "notes", {}, visitor)).status).toBe(404);
	});
});

describe("the pages and kinds a host registered", () => {
	const hosted = async () => ({
		pages: [{ id: "crm", label: "CRM", place: "main" as const }],
		kinds: [{ kind: "case", label: "Cases" }],
	});

	test("an owners-only host sends them too when it has any, and nothing extra when it has none", async () => {
		const withAny = await call<ConfigView>(api({ hosted }).api, "config");
		expect(withAny.body).toMatchObject({
			pages: [{ id: "crm", label: "CRM", place: "main" }],
			kinds: [{ kind: "case", label: "Cases" }],
		});
		expect(withAny.body).not.toHaveProperty("tier");
		expect(withAny.body).not.toHaveProperty("push");
		const none = await call<ConfigView>(
			api({ hosted: async () => ({ pages: [], kinds: [] }) }).api,
			"config",
		);
		const plain = await call<ConfigView>(api().api, "config");
		expect(JSON.stringify(none.body)).toBe(JSON.stringify(plain.body));
	});
});
