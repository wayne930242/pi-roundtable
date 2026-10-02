import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS, MEMORY } from "pi-roundtable";
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
} from "./api-types.ts";
import { cloudflareAccess } from "./cloudflare-access.ts";
import {
	AUDIENCE,
	accessKeys,
	fakeMemory,
	fixtureSessions,
	ORIGIN,
	OWNER_CHANNEL,
	OWNER_EMAIL,
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
const memory = servicePair(MEMORY, {
	forSpeaker: () =>
		fakeMemory([{ kind: "core", fact: "Likes tea", eventDate: null }]),
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

async function boot(options: Partial<Parameters<typeof webConsole>[0]> = {}) {
	const harness = await testPlugin(webConsole({ ...base(), ...options }), {
		services: [agents, memory, discord],
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
		["an unknown pane", { panes: ["skills"] }, "unknown pane"],
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

	test("with a page that was never built", async () => {
		await expect(
			testPlugin(webConsole({ ...base(), assetDir: "/nonexistent-page" }), {
				services: [agents, memory, discord],
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
		expect(overview).toEqual({
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

	test("leaves the notes pane unserved when memory is not asked for", async () => {
		const { call } = await boot({ panes: ["conversations", "overview"] });
		expect((await call("/console/api/notes", {}, await sign())).status).toBe(
			404,
		);
	});
});
