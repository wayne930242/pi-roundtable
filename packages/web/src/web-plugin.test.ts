import { describe, expect, test } from "bun:test";
import { AGENTS } from "pi-roundtable";
import { CATALOG, EAST_ASIAN_SKINS } from "pi-roundtable/characters";
import { testPlugin } from "pi-roundtable/testing";
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
	type FakePrincipal,
	ORIGIN,
	OWNER_CHANNEL,
	OWNER_EMAIL,
	TEAM,
} from "./testing/fixtures.ts";
import {
	agents,
	base,
	boot,
	discord,
	harnesses,
	identity,
	keys,
	MEMBER,
	MEMBER_EMAIL,
	memory,
	OWNER,
	SECOND,
	SECOND_EMAIL,
	sign,
	teamChanges,
	webPluginHostPerTest,
} from "./testing/web-plugin-host.ts";
import { admit } from "./verifier.ts";
import { webConsole } from "./web-plugin.ts";

webPluginHostPerTest();

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
			look: "modern",
			characterSkins: [...CATALOG.skins],
		});
		expect((await call("/ops/web/api/notes", {}, await sign())).status).toBe(
			404,
		);
	});

	test("a cloudflareAccess owner is served the 0.25 console unchanged: the same config, and every 0.25 route answers", async () => {
		const { call } = await boot();
		const jwt = await sign();
		const config = await call("/console/api/config", {}, jwt);
		// Byte for byte what 0.25 sent: no tier, gate, pages or push, and no app section.
		expect(await config.text()).toBe(
			JSON.stringify({
				title: "Roundtable",
				panes: ["overview", "conversations", "notes"],
				timeZone: "UTC",
				look: "modern",
				characterSkins: [...CATALOG.skins],
			}),
		);
		for (const path of [
			"overview",
			"dashboard",
			"conversations",
			"notes",
			"principals",
		]) {
			const answer = await call(`/console/api/${path}`, {}, jwt);
			expect({
				path,
				status: answer.status < 500 && answer.status !== 404,
			}).toEqual({ path, status: true });
		}
		// Routes that were never 0.25's stay closed to everyone, owner included.
		for (const path of ["host/case", "notices", "profile", "pages/crm"])
			expect((await call(`/console/api/${path}`, {}, jwt)).status).toBe(404);
	});

	test("the page is handed the host's skin tones, so every character it draws wears them", async () => {
		const harness = await testPlugin(webConsole(base()), {
			services: [agents, memory, discord, identity()],
			env: { characterSkins: EAST_ASIAN_SKINS },
		});
		harnesses.push(harness);
		const route = harness.contribution.http?.find(
			(r) => r.name === "web-console",
		);
		if (!route) throw new Error("no route");
		const response = await route.handle(
			new Request("http://host/console/api/config", {
				headers: { "cf-access-jwt-assertion": await sign() },
			}),
		);
		expect(
			((await response.json()) as { characterSkins: string[] }).characterSkins,
		).toEqual([...EAST_ASIAN_SKINS]);
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
