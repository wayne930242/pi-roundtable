import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS, IDENTITY, MEMORY } from "pi-roundtable";
import { DISCORD } from "pi-roundtable/discord";
import {
	partial,
	servicePair,
	type TestPluginResult,
	testPlugin,
} from "pi-roundtable/testing";
import type {
	ConfigView,
	ConversationsView,
	NoteView,
	OverviewView,
	PrincipalsView,
} from "./api-types.ts";
import { cloudflareAccess } from "./cloudflare-access.ts";
import {
	AUDIENCE,
	accessIdentity,
	accessKeys,
	type FakePrincipal,
	fakeIdentity,
	fakeMemory,
	fixtureSessions,
	ORIGIN,
	OWNER_CHANNEL,
	OWNER_EMAIL,
	OWNER_SUB,
	TEAM,
} from "./testing/fixtures.ts";
import { admit } from "./verifier.ts";
import { webConsole } from "./web-plugin.ts";

const { keys, sign } = await accessKeys();
const verifier = cloudflareAccess({
	teamDomain: TEAM,
	audience: AUDIENCE,
	email: OWNER_EMAIL,
	keys,
});

/** A built page stand-in: the plugin reads whatever is in the directory. */
function assetDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "web-console-page-"));
	writeFileSync(join(dir, "index.html"), "<html>console</html>");
	return dir;
}

const harnesses: TestPluginResult[] = [];
afterEach(async () => {
	await Promise.all(harnesses.splice(0).map((harness) => harness.stop()));
});

const teamChanges: (() => void)[] = [];
const agents = servicePair(AGENTS, {
	team: partial({
		guildId: "900000000000000099",
		onChange: (listener: () => void) => teamChanges.push(listener),
		owns: () => undefined,
		status: async () => ({ agents: [], groups: [] }),
	}) as never,
});
/** The owner, as the configuration links their Access identity, and their memory. */
const OWNER: FakePrincipal = {
	id: "owner",
	name: "Owner",
	tier: "owner",
	identities: [accessIdentity(OWNER_SUB)],
};
const SECOND_EMAIL = "second@example.test";
const SECOND: FakePrincipal = {
	id: "p_01J0000000000000000000BEA0",
	name: "Bea",
	tier: "owner",
	identities: [accessIdentity("bea")],
};
const MEMBER_EMAIL = "member@example.test";
const MEMBER: FakePrincipal = {
	id: "p_01J0000000000000000000MEL0",
	name: "Mel",
	tier: "member",
	identities: [accessIdentity("mel")],
};
const identity = (people: FakePrincipal[] = [OWNER]) =>
	servicePair(IDENTITY, fakeIdentity(people));
/** Each principal's memory, kept like the store keeps it: the same rows on every read. */
const memories = new Map<string, ReturnType<typeof fakeMemory>>();
afterEach(() => memories.clear());
const memory = servicePair(MEMORY, {
	forSpeaker: (id: string) => {
		const found =
			memories.get(id) ??
			fakeMemory([
				{
					kind: "core",
					fact: id === OWNER.id ? "Likes tea" : `Notes of ${id}`,
					eventDate: null,
				},
			]);
		memories.set(id, found);
		return found;
	},
});
const discord = servicePair(DISCORD, {
	connection: partial({
		channelInfo: async () => ({ kind: "dm" as const, name: "Owner" }),
	}) as never,
});

const base = () => ({
	verifier,
	origin: ORIGIN,
	ownerId: "owner",
	dataDir: fixtureSessions(),
	assetDir: assetDir(),
});

async function boot(
	options: Partial<Parameters<typeof webConsole>[0]> = {},
	people?: FakePrincipal[],
) {
	const harness = await testPlugin(webConsole({ ...base(), ...options }), {
		services: [agents, memory, discord, identity(people)],
	});
	harnesses.push(harness);
	const route = (name: string) => {
		const found = harness.contribution.http?.find((r) => r.name === name);
		if (!found) throw new Error(`no route ${name}`);
		return found;
	};
	const call = async (path: string, init: RequestInit = {}, jwt?: string) =>
		route("web-console").handle(
			new Request(`http://host${path}`, {
				...init,
				headers: {
					...(jwt ? { "cf-access-jwt-assertion": jwt } : {}),
					...init.headers,
				},
			}),
		);
	return { harness, call, route };
}

describe("refuses to start", () => {
	test("without a verifier, however the option is missing", () => {
		const { verifier: _omitted, ...rest } = base();
		expect(() => webConsole(rest as never)).toThrow("no verifier");
		expect(() =>
			webConsole({ ...base(), verifier: undefined } as never),
		).toThrow("no verifier");
		expect(() => webConsole({ ...base(), verifier: "yes" } as never)).toThrow(
			"no verifier",
		);
		expect(() => webConsole(undefined as never)).toThrow();
	});

	test.each([
		["an origin that is not a URL", { origin: "console" }, "origin"],
		[
			"an origin with a path",
			{ origin: "https://console.example.test/app" },
			"origin",
		],
		[
			"an origin that is not http or https",
			{ origin: "ftp://console.example.test" },
			"origin",
		],
		["a mount path with no segment", { mountPath: "/" }, "mountPath"],
		[
			"a mount path without a leading slash",
			{ mountPath: "console" },
			"mountPath",
		],
		["a mount path with a dot segment", { mountPath: "/a/../b" }, "mountPath"],
		["a mount path with a space", { mountPath: "/my console" }, "mountPath"],
		["no panes", { panes: [] }, "panes"],
		["an unknown pane", { panes: ["unknown"] }, "unknown pane"],
		["a repeated pane", { panes: ["notes", "notes"] }, "twice"],
		["notes with no owner id", { ownerId: " " }, "ownerId"],
		["an empty title", { title: " " }, "title"],
	])("with %s", (_name, change, message) => {
		expect(() => webConsole({ ...base(), ...change } as never)).toThrow(
			message,
		);
	});

	test("a notes-less console needs no owner id", () => {
		expect(() =>
			webConsole({ ...base(), ownerId: undefined, panes: ["conversations"] }),
		).not.toThrow();
	});

	test("the notes pane needs no owner id either: it shows the visitor's own notes", () => {
		expect(() => webConsole({ ...base(), ownerId: undefined })).not.toThrow();
	});

	test("with a page that was never built", async () => {
		await expect(
			testPlugin(webConsole({ ...base(), assetDir: "/nonexistent-page" }), {
				services: [agents, memory, discord, identity()],
			}),
		).rejects.toThrow("not built");
	});
});

describe("webConsole on a plugin harness", () => {
	test("adds two routes on the public listener under /console, a service, and a dashboard line", async () => {
		const { harness } = await boot();
		expect(harness.contribution.http?.map((r) => [r.listener, r.path])).toEqual(
			[
				["public", { exact: "/console" }],
				["public", { prefix: "/console/" }],
			],
		);
		expect(harness.contribution.services?.map((s) => s.name)).toEqual([
			"web-console",
		]);
		expect(harness.contribution.dashboard).toEqual([
			"Web console: https://console.example.test/console/",
		]);
	});

	test("the mount, listener, title, and panes are options", async () => {
		const { harness, call } = await boot({
			mountPath: "/ops/web/",
			listener: "private",
			title: "Ops",
			panes: ["conversations"],
		});
		expect(harness.contribution.http?.[1]).toMatchObject({
			listener: "private",
			path: { prefix: "/ops/web/" },
		});
		const config = await call("/ops/web/api/config", {}, await sign());
		expect(await config.json()).toEqual({
			title: "Ops",
			panes: ["conversations"],
			timeZone: "UTC",
		});
		expect((await call("/ops/web/api/notes", {}, await sign())).status).toBe(
			404,
		);
	});

	test("a request without a valid assertion is refused; a valid one is admitted", async () => {
		const { call } = await boot();
		expect((await call("/console/")).status).toBe(403);
		expect((await call("/console/api/config")).status).toBe(403);
		expect(
			(await call("/console/api/config", {}, "forged.jwt.value")).status,
		).toBe(403);
		expect(
			(
				await call(
					"/console/api/config",
					{},
					await sign({ email: "x@example.test" }),
				)
			).status,
		).toBe(403);
		const jwt = await sign();
		const page = await call("/console/", {}, jwt);
		expect(page.status).toBe(200);
		expect(await page.text()).toBe("<html>console</html>");
		const config = (await (
			await call("/console/api/config", {}, jwt)
		).json()) as ConfigView;
		expect(config.panes).toEqual(["overview", "conversations", "notes"]);
	});

	test("a change from another origin is refused even with a valid assertion", async () => {
		const { call } = await boot();
		const jwt = await sign();
		const post = (origin?: string) =>
			call(
				"/console/api/notes",
				{
					method: "POST",
					body: JSON.stringify({ fact: "Walks daily", kind: "note" }),
					headers: {
						"content-type": "application/json",
						...(origin ? { origin } : {}),
					},
				},
				jwt,
			);
		expect((await post("https://evil.example.test")).status).toBe(403);
		expect((await post()).status).toBe(403);
		expect((await post(ORIGIN)).status).toBe(201);
		const notes = (await (
			await call("/console/api/notes", {}, jwt)
		).json()) as NoteView[];
		expect(notes.map((n) => n.fact)).toEqual(["Likes tea", "Walks daily"]);
	});

	test("answers JSON for the fixture conversations, with the host's Discord names", async () => {
		const { call } = await boot();
		const jwt = await sign();
		const view = (await (
			await call("/console/api/conversations", {}, jwt)
		).json()) as ConversationsView;
		expect(view.conversations).toHaveLength(5);
		expect(
			view.conversations.find((c) => c.id === OWNER_CHANNEL)?.channel,
		).toEqual({ kind: "dm", name: "Owner" });
		const overview = (await (
			await call("/console/api/overview", {}, jwt)
		).json()) as OverviewView;
		expect(overview).toMatchObject({
			guildId: "900000000000000099",
			agents: [],
			groups: [],
		});
	});

	test("the exclude option hides conversations", async () => {
		const { call } = await boot({
			exclude: (key) => key.startsWith("mcp:"),
		});
		const view = (await (
			await call("/console/api/conversations", {}, await sign())
		).json()) as ConversationsView;
		expect(view.conversations.map((c) => c.kind)).not.toContain("outside");
	});

	test("a custom verifier is used as it is", async () => {
		const seen: string[] = [];
		const { call } = await boot({
			verifier: (request) => {
				seen.push(request.headers.get("x-user") ?? "");
				return request.headers.get("x-user") === "owner"
					? admit()
					: { admitted: false, reason: "not the owner" };
			},
		});
		expect((await call("/console/api/config")).status).toBe(403);
		expect(
			(await call("/console/api/config", { headers: { "x-user": "owner" } }))
				.status,
		).toBe(200);
		expect(seen).toEqual(["", "owner"]);
	});

	test("a change in the queue or the team reaches an open event stream, and a note written through the console does too", async () => {
		const { harness, call } = await boot();
		const jwt = await sign();
		const response = await call("/console/api/events", {}, jwt);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("no stream");
		const decoder = new TextDecoder();
		await reader.read(); // the retry line
		const next = async () => decoder.decode((await reader.read()).value);
		for (const listener of teamChanges) listener();
		expect(await next()).toBe("event: changed\ndata: {}\n\n");
		const added = await call(
			"/console/api/notes",
			{
				method: "POST",
				body: JSON.stringify({ fact: "Another", kind: "note" }),
				headers: { origin: ORIGIN },
			},
			jwt,
		);
		expect(added.status).toBe(201);
		expect(await next()).toBe("event: changed\ndata: {}\n\n");
		await harness.stop();
		harnesses.length = 0;
	});

	test("feature panes fail startup without hooks, and asynchronous factories receive public context", async () => {
		await expect(boot({ panes: ["skills"] })).rejects.toThrow(
			"skills pane needs",
		);
		await expect(boot({ panes: ["connectors"] })).rejects.toThrow(
			"connectors pane needs",
		);
		const { call } = await boot({
			panes: ["skills", "connectors"],
			routing: "path",
			presentation: { locale: "fr", messages: { Skills: "Translated skills" } },
			features: async (context) => {
				expect(context.services.find(AGENTS)).toBeDefined();
				return {
					skills: {
						catalog: () => [],
						read: async () => ({ frontmatter: {}, body: "" }),
					},
					connectors: {
						gateways: async () => [],
						servers: async () => [],
						usedBy: () => [],
					},
				};
			},
		});
		const jwt = await sign();
		expect(await (await call("/console/api/skills", {}, jwt)).json()).toEqual(
			[],
		);
		expect(
			await (await call("/console/api/connectors", {}, jwt)).json(),
		).toEqual({ gateways: [], servers: [] });
		expect(
			await (await call("/console/api/config", {}, jwt)).json(),
		).toMatchObject({
			locale: "fr",
			mountPath: "/console",
			messages: { Skills: "Translated skills" },
		});
		expect((await call("/console/skills", {}, jwt)).status).toBe(200);
		expect((await call("/console/unknown.path", {}, jwt)).status).toBe(200);
		expect((await call("/console/skills")).status).toBe(403);
	});

	test("leaves the notes pane unserved when memory is not asked for", async () => {
		const { call } = await boot({ panes: ["conversations", "overview"] });
		expect((await call("/console/api/notes", {}, await sign())).status).toBe(
			404,
		);
	});
});

describe("several owners", () => {
	const verifyBoth = cloudflareAccess({
		teamDomain: TEAM,
		audience: AUDIENCE,
		email: [OWNER_EMAIL, SECOND_EMAIL, MEMBER_EMAIL],
		keys,
	});
	const people = [OWNER, SECOND, MEMBER];
	const asSecond = () => sign({ email: SECOND_EMAIL, sub: "bea" });

	test("each owner signs in and sees every conversation", async () => {
		const { call } = await boot(
			{ verifier: verifyBoth, ownerId: undefined },
			people,
		);
		for (const jwt of [await sign(), await asSecond()]) {
			expect((await call("/console/", {}, jwt)).status).toBe(200);
			const view = (await (
				await call("/console/api/conversations", {}, jwt)
			).json()) as ConversationsView;
			expect(view.conversations).toHaveLength(5);
		}
	});

	test("a member the verifier vouches for is refused everywhere", async () => {
		const { call } = await boot({ verifier: verifyBoth }, people);
		const jwt = await sign({ email: MEMBER_EMAIL, sub: "mel" });
		for (const path of [
			"/console/",
			"/console/api/config",
			"/console/api/conversations",
			"/console/api/notes",
			"/console/api/events",
		])
			expect((await call(path, {}, jwt)).status).toBe(403);
	});

	test("an identity linked to no one is refused once there are two owners", async () => {
		const { call } = await boot({ verifier: verifyBoth }, people);
		const jwt = await sign({ email: SECOND_EMAIL, sub: "someone-else" });
		expect((await call("/console/api/config", {}, jwt)).status).toBe(403);
	});

	test("the notes pane shows the visitor's own notes, and switches to another principal's", async () => {
		const { call } = await boot({ verifier: verifyBoth }, people);
		const facts = async (path: string, jwt: string) =>
			((await (await call(path, {}, jwt)).json()) as NoteView[]).map(
				(n) => n.fact,
			);
		const owner = await sign();
		const second = await asSecond();
		expect(await facts("/console/api/notes", owner)).toEqual(["Likes tea"]);
		expect(await facts("/console/api/notes", second)).toEqual([
			`Notes of ${SECOND.id}`,
		]);
		expect(
			await facts(`/console/api/notes?principal=${OWNER.id}`, second),
		).toEqual(["Likes tea"]);
		expect(
			await facts(`/console/api/notes?principal=${MEMBER.id}`, owner),
		).toEqual([`Notes of ${MEMBER.id}`]);
		const listed = (await (
			await call("/console/api/principals", {}, second)
		).json()) as PrincipalsView;
		expect(listed.self).toBe(SECOND.id);
		expect(listed.principals.map((p) => p.name)).toEqual([
			"Bea",
			"Owner",
			"Mel",
		]);
	});
});

describe("one owner", () => {
	test("an Access identity not yet linked is refused, even with a single owner", async () => {
		const { call } = await boot({}, [OWNER]);
		const jwt = await sign({ sub: "not-linked-yet" });
		for (const path of [
			"/console/",
			"/console/api/config",
			"/console/api/notes",
		])
			expect((await call(path, {}, jwt)).status).toBe(403);
	});

	test("a member whose Access identity is linked to no one is refused, though her Discord identity is linked", async () => {
		const alice: FakePrincipal = {
			id: "p_01J0000000000000000000ALI0",
			name: "Alice",
			tier: "member",
			identities: ["discord:222"],
		};
		const verifyAlice = cloudflareAccess({
			teamDomain: TEAM,
			audience: AUDIENCE,
			email: [OWNER_EMAIL, "alice@example.test"],
			keys,
		});
		const { call } = await boot({ verifier: verifyAlice }, [OWNER, alice]);
		const jwt = await sign({
			email: "alice@example.test",
			sub: "alice-cf-sub",
		});
		for (const path of [
			"/console/",
			"/console/api/config",
			"/console/api/conversations",
			"/console/api/notes",
			"/console/api/events",
		])
			expect((await call(path, {}, jwt)).status).toBe(403);
		expect((await call("/console/api/config", {}, await sign())).status).toBe(
			200,
		);
	});

	test("the owner's linked Access identity enters, notes and all", async () => {
		const { call } = await boot({}, [OWNER]);
		const notes = (await (
			await call("/console/api/notes", {}, await sign())
		).json()) as NoteView[];
		expect(notes.map((n) => n.fact)).toEqual(["Likes tea"]);
	});

	test("a verifier that reports no actor is the primary owner, notes and all", async () => {
		const { call } = await boot({ verifier: () => admit() }, [OWNER, SECOND]);
		const notes = (await (
			await call("/console/api/notes")
		).json()) as NoteView[];
		expect(notes.map((n) => n.fact)).toEqual(["Likes tea"]);
	});

	test("ownerId names the owner a verifier without an actor speaks for", async () => {
		const { call } = await boot(
			{ verifier: () => admit(), ownerId: SECOND.id },
			[OWNER, SECOND],
		);
		const notes = (await (
			await call("/console/api/notes")
		).json()) as NoteView[];
		expect(notes.map((n) => n.fact)).toEqual([`Notes of ${SECOND.id}`]);
	});
});
