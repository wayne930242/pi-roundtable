import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import type { Agent, InboundMessage } from "pi-roundtable";
import {
	describeDb,
	silentLogger,
	testDatabaseUrl,
} from "pi-roundtable/testing";
import type { NewRoomMessage } from "../app/room-log.ts";
import { webhookRoute } from "./owner-routes.ts";
import { MAX_POST_TEXT } from "./post-body.ts";
import { WebhookStore } from "./store.ts";
import { type WebhooksSlot, webhookActs } from "./tools.ts";
import { POSTS_PER_MINUTE, Webhooks } from "./webhooks.ts";

const BASE = "https://hooks.example.com/app";

const knight = (name: string, extra: Partial<Agent> = {}): Agent => ({
	name,
	displayName: name,
	prompt: "",
	avatarPrompt: "",
	status: "active",
	...extra,
});

describeDb("incoming webhooks", () => {
	let sql: SQL;
	let store: WebhookStore;
	let webhooks: Webhooks;
	let shown: NewRoomMessage[];
	let handed: InboundMessage[];
	let now: number;
	const agents = new Map<string, Agent>();

	beforeAll(async () => {
		// The table is created if absent and never dropped: the host-migrated ledger would not recreate it.
		sql = new SQL(testDatabaseUrl, { max: 4 });
		await WebhookStore.migration.up(sql);
		store = new WebhookStore(sql);
	});
	afterAll(async () => {
		await sql`DELETE FROM web_webhooks`;
		await sql.close();
	});
	beforeEach(async () => {
		await sql`DELETE FROM web_webhooks`;
		shown = [];
		handed = [];
		now = Date.now();
		agents.clear();
		for (const one of [
			knight("infra"),
			knight("coder"),
			knight("gone", { status: "archived" }),
			knight("temp", { parent: "infra" }),
		])
			agents.set(one.name, one);
		webhooks = new Webhooks({
			store,
			directory: { agent: (name) => agents.get(name) },
			surface: {
				publish: async (row) => {
					shown.push(row);
					return {
						id: shown.length,
						room: row.room,
						kind: row.kind,
						author: row.author,
						text: row.text,
						files: [],
						at: new Date().toISOString(),
					};
				},
				deliver: (message) => void handed.push(message),
			},
			surfaceName: "app",
			base: BASE,
			now: () => now,
			logger: silentLogger(),
		});
	});

	const make = async (agent = "infra", extra: Record<string, unknown> = {}) => {
		const made = await webhooks.create(
			agent,
			{ name: "CI", ...extra },
			"owner",
		);
		const [, , , id, token] = new URL(made.url).pathname.split("/");
		return { ...made, id: id as string, token: token as string };
	};
	const send = (
		path: string,
		body: unknown,
		init: RequestInit = { method: "POST" },
	) =>
		webhooks.post(
			new Request(`${BASE}/${path}`, {
				...init,
				...(init.method === "GET"
					? {}
					: { body: typeof body === "string" ? body : JSON.stringify(body) }),
			}),
			path,
		);
	const pathOf = (hook: { id: string; token: string }) =>
		`hooks/${hook.id}/${hook.token}`;

	test("a Discord-shaped post shows one integration message and hands the host one webhook message", async () => {
		const hook = await make();
		expect(hook.url).toStartWith(`${BASE}/hooks/`);
		const response = await send(pathOf(hook), {
			content: "build 12 failed",
			username: "GitHub CI",
		});
		expect(response.status).toBe(204);
		expect(shown).toEqual([
			{
				room: "app:agent.infra",
				kind: "integration",
				author: "GitHub CI",
				text: "build 12 failed",
				files: [],
			},
		]);
		expect(handed).toHaveLength(1);
		expect(handed[0]).toMatchObject({
			channel: "app:agent.infra",
			messageId: "app-1",
			authorName: "CI",
			authorIsBot: true,
			integration: { id: hook.id, own: false },
			text: "build 12 failed",
			attachments: [],
		});
		expect(handed[0]?.actor).toBeUndefined();
		expect((await webhooks.list("infra"))[0]?.lastUsed).not.toBeNull();
	});

	test("takes `text` for `content`, and the webhook's name when no username is given", async () => {
		const hook = await make();
		expect((await send(pathOf(hook), { text: "deploy done" })).status).toBe(
			204,
		);
		expect(shown[0]).toMatchObject({ author: "CI", text: "deploy done" });
		await send(pathOf(hook), { content: "x", username: "y".repeat(81) });
		expect(shown[1]?.author).toBe("CI");
	});

	test("shows any other JSON as a fenced block, cut to fit", async () => {
		const hook = await make();
		await send(pathOf(hook), { status: "failed", jobs: [1, 2] });
		expect(shown[0]?.text).toBe(
			`\`\`\`json\n${JSON.stringify({ status: "failed", jobs: [1, 2] }, null, 2)}\n\`\`\``,
		);
		await send(pathOf(hook), ["a".repeat(9000)]);
		const cut = shown[1]?.text ?? "";
		expect(cut.length).toBeLessThanOrEqual(MAX_POST_TEXT);
		expect(cut).toStartWith("```json\n[");
		expect(cut).toEndWith("…\n```");
		await send(pathOf(hook), { content: "   " });
		expect(shown[2]?.text).toStartWith("```json\n");
	});

	test("answers the same bare 404 for a wrong token, an unknown id, a revoked or expired webhook and an archived knight", async () => {
		const good = await make();
		const revoked = await make();
		await webhooks.revoke("infra", revoked.id);
		const expiring = await make("infra", { expiresInMinutes: 1 });
		await sql`UPDATE web_webhooks SET expires_at = now() - interval '1 second' WHERE id = ${expiring.id}`;
		const archived = await make("coder");
		agents.set("coder", knight("coder", { status: "archived" }));
		const answers = await Promise.all(
			[
				`hooks/${good.id}/${good.token}x`,
				`hooks/nope/${good.token}`,
				pathOf(revoked),
				pathOf(expiring),
				pathOf(archived),
				`hooks/${good.id}`,
			].map(async (path) => {
				const response = await send(path, { content: "hi" });
				return [response.status, await response.text()];
			}),
		);
		expect(answers).toEqual(Array(6).fill([404, "Not found"]));
		expect(shown).toEqual([]);
		expect(handed).toEqual([]);
	});

	test("refuses an empty, oversized or non-JSON body, and any method but POST", async () => {
		const hook = await make();
		expect((await send(pathOf(hook), "")).status).toBe(400);
		expect((await send(pathOf(hook), "not json")).status).toBe(400);
		expect((await send(pathOf(hook), "42")).status).toBe(400);
		expect(
			(await send(pathOf(hook), { content: "x".repeat(17 * 1024) })).status,
		).toBe(413);
		expect(
			(await send(pathOf(hook), undefined, { method: "GET" })).status,
		).toBe(405);
		expect(shown).toEqual([]);
	});

	test("holds a webhook to 30 posts a minute", async () => {
		const hook = await make();
		for (let i = 0; i < POSTS_PER_MINUTE; i++)
			expect((await send(pathOf(hook), { content: `${i}` })).status).toBe(204);
		expect((await send(pathOf(hook), { content: "more" })).status).toBe(429);
		now += 61_000;
		expect((await send(pathOf(hook), { content: "later" })).status).toBe(204);
	});

	test("revokes a `once` webhook after its first accepted post", async () => {
		const hook = await make("infra", { once: true });
		expect((await send(pathOf(hook), "bad")).status).toBe(400);
		expect((await send(pathOf(hook), { content: "one" })).status).toBe(204);
		expect((await send(pathOf(hook), { content: "two" })).status).toBe(404);
		expect(await webhooks.list("infra")).toEqual([]);
	});

	test("keeps only the token's hash, and never shows the token again", async () => {
		const hook = await make();
		const [row]: { token_hash: string }[] =
			await sql`SELECT token_hash FROM web_webhooks WHERE id = ${hook.id}`;
		expect(row?.token_hash).toBe(
			new Bun.CryptoHasher("sha256").update(hook.token).digest("hex"),
		);
		const listed = JSON.stringify(await webhooks.list("infra"));
		expect(listed).not.toContain(hook.token);
		expect(listed).not.toContain(row?.token_hash as string);
		expect(Object.keys((await webhooks.list("infra"))[0] ?? {}).sort()).toEqual(
			["created", "createdBy", "expiresAt", "id", "lastUsed", "name", "once"],
		);
	});

	test("the agent's tools act on the caller's own webhooks only, within the caps and the longest expiry", async () => {
		const slot: WebhooksSlot = { current: webhooks };
		const acts = webhookActs(slot);
		const turn = (name: string, group?: string) => ({
			agent: {
				name,
				session: `app:agent.${name}` as never,
				home: `app:agent.${name}` as never,
				...(group ? { group } : {}),
			},
		});
		const made = await acts.create({ name: "alerts" }, turn("infra"));
		expect(made).toContain(`${BASE}/hooks/`);
		expect(made).toContain("secret");
		const [own] = await webhooks.list("infra");
		expect(own?.createdBy).toBe("infra");
		expect(await acts.list(turn("coder"))).toBe("Your room has no webhooks.");
		await expect(
			acts.revoke({ id: own?.id as string }, turn("coder")),
		).rejects.toThrow("no live webhook");
		expect(await acts.list(turn("infra"))).not.toContain("/hooks/");
		await expect(acts.create({ name: "x" }, turn("temp"))).rejects.toThrow(
			"temp knight",
		);
		await expect(
			acts.create({ name: "x" }, turn("infra", "council")),
		).rejects.toThrow("group");
		await expect(
			acts.create({ name: "x" }, { agent: undefined }),
		).rejects.toThrow("permanent knight");
		await expect(
			acts.create(
				{ name: "x", expires_in_minutes: 7 * 24 * 60 + 1 },
				turn("infra"),
			),
		).rejects.toThrow("7 days");
		for (let i = 1; i < 10; i++)
			await acts.create({ name: `lasting ${i}` }, turn("infra"));
		await expect(
			acts.create({ name: "eleventh" }, turn("infra")),
		).rejects.toThrow("10 webhooks");
		for (let i = 0; i < 20; i++)
			await acts.create(
				{ name: `short ${i}`, expires_in_minutes: 60 },
				turn("infra"),
			);
		await expect(
			acts.create({ name: "short 21", expires_in_minutes: 60 }, turn("infra")),
		).rejects.toThrow("20 expiring");
		expect(await acts.revoke({ id: own?.id as string }, turn("infra"))).toBe(
			`Revoked webhook ${own?.id}.`,
		);
		await expect(webhookActs({}).list(turn("infra"))).rejects.toThrow(
			"not served",
		);
	});

	test("the owner's routes list, make and revoke a permanent knight's webhooks, showing the URL only when made", async () => {
		const call = (method: string, rest: string, body?: unknown) =>
			webhookRoute(
				webhooks,
				new Request(`${BASE}/${rest}`, {
					method,
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				}),
				rest,
				undefined,
			);
		const made = await call("POST", "api/agents/infra/webhooks", {
			name: "CI",
			expiresInMinutes: 30,
			once: true,
		});
		expect(made?.status).toBe(201);
		const created = (await made?.json()) as {
			url: string;
			webhook: { id: string; createdBy: string; once: boolean };
		};
		expect(created.url).toStartWith(`${BASE}/hooks/${created.webhook.id}/`);
		expect(created.webhook).toMatchObject({ createdBy: "owner", once: true });
		const listed = await call("GET", "api/agents/infra/webhooks");
		const text = await listed?.text();
		expect(text).toContain(created.webhook.id);
		expect(text).not.toContain(created.url.split("/").pop() as string);
		expect(
			(await call("POST", "api/agents/infra/webhooks", { name: " " }))?.status,
		).toBe(400);
		for (const agent of ["temp", "gone", "nobody"])
			expect((await call("GET", `api/agents/${agent}/webhooks`))?.status).toBe(
				404,
			);
		expect(
			(await call("DELETE", `api/agents/coder/webhooks/${created.webhook.id}`))
				?.status,
		).toBe(404);
		expect(
			(await call("DELETE", `api/agents/infra/webhooks/${created.webhook.id}`))
				?.status,
		).toBe(204);
		expect(await webhooks.list("infra")).toEqual([]);
		expect(await call("GET", "api/agents/infra")).toBeUndefined();
	});

	test("`GET api/webhooks` lists every knight's live webhooks by knight, never a token or hash", async () => {
		agents.set("coder", knight("coder", { displayName: "Coder" }));
		const ci = await webhooks.create("infra", { name: "CI" }, "owner");
		const first = await webhooks.create("coder", { name: "A" }, "coder");
		const gone = await webhooks.create("coder", { name: "B" }, "owner");
		await webhooks.create(
			"coder",
			{ name: "Soon", expiresInMinutes: 1 },
			"owner",
		);
		await webhooks.revoke("coder", gone.webhook.id);
		await sql`UPDATE web_webhooks SET expires_at = now() - interval '1 second' WHERE name = 'Soon'`;
		const answer = await webhookRoute(
			webhooks,
			new Request(`${BASE}/api/webhooks`),
			"api/webhooks",
			undefined,
		);
		const text = (await answer?.text()) ?? "";
		for (const made of [ci, first])
			expect(text).not.toContain(made.url.split("/").pop() as string);
		expect(text).not.toContain("hash");
		const { webhooks: listed } = JSON.parse(text) as {
			webhooks: Record<string, unknown>[];
		};
		expect(listed.map((one) => [one.agent, one.name])).toEqual([
			["coder", "A"],
			["infra", "CI"],
		]);
		expect(listed[0]).toMatchObject({
			agentDisplayName: "Coder",
			id: first.webhook.id,
			createdBy: "coder",
			once: false,
			lastUsed: null,
			expiresAt: null,
		});
		// The expired one was swept, as the per-knight list sweeps.
		const [swept] =
			await sql`SELECT revoked_at FROM web_webhooks WHERE name = 'Soon'`;
		expect(swept.revoked_at).not.toBeNull();
		const posted = await webhookRoute(
			webhooks,
			new Request(`${BASE}/api/webhooks`, { method: "POST" }),
			"api/webhooks",
			undefined,
		);
		expect(posted?.status).toBe(405);
	});
});
