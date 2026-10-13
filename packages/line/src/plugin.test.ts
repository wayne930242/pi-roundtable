import { afterAll, beforeEach, expect, test } from "bun:test";
import type { SQL } from "bun";
import type {
	Contribution,
	PluginContext,
	Service,
	ServiceKey,
} from "pi-roundtable";
import { describeDb, partial, recordingLogger } from "pi-roundtable/testing";
import type { InboxEvent } from "./inbox.ts";
import { line } from "./plugin.ts";
import { LINE, type LineBridgePort } from "./port.ts";
import {
	BOT,
	body,
	CHANNEL_ID,
	fakeLine,
	GROUP,
	messageEvent,
	SECRET,
	sign,
	webhookRequest,
} from "./testing/line-fake.ts";
import { freshPool } from "./testing/pool.ts";

const credentials = { channelId: CHANNEL_ID, channelSecret: SECRET };

test("a configuration mistake throws when the plugin is made, before the host starts", () => {
	expect(() =>
		line({ credentials: { ...credentials, channelId: "x" } }),
	).toThrow("channelId");
	expect(() =>
		line({ credentials: { ...credentials, channelSecret: "" } }),
	).toThrow("channelSecret");
	expect(() => line({ credentials, webhookPath: "line/hook" })).toThrow(
		"webhookPath",
	);
	expect(() => line({ credentials, webhookPath: "/line/" })).toThrow(
		"webhookPath",
	);
	expect(() => line({ credentials, inbox: { maxAttempts: 0 } })).toThrow(
		"inbox.maxAttempts",
	);
	expect(() => line({ credentials, inbox: { nope: 1 } as never })).toThrow(
		"inbox.nope",
	);
});

describeDb("the line plugin", () => {
	let sql: SQL;
	const time = new Date("2026-10-13T00:00:00Z");
	const logs = recordingLogger();
	let provided: unknown;

	const context = (): PluginContext =>
		partial<PluginContext>({
			logger: logs.logger,
			env: partial<PluginContext["env"]>({ now: () => time }),
			database: () => sql,
			services: partial<PluginContext["services"]>({
				provide: <T>(key: ServiceKey<T>, value: T) => {
					expect(key.id).toBe(LINE.id);
					provided = value;
				},
			}),
		});
	const boot = async (options: Partial<Parameters<typeof line>[0]> = {}) => {
		const fake = fakeLine();
		const plugin = line({
			credentials,
			fetch: fake.fetch,
			inbox: { pollMs: 20 },
			...options,
		});
		const contribution: Contribution = await plugin.setup(context());
		const service = (name: string): Service => {
			const found = contribution.services?.find((s) => s.name === name);
			if (!found) throw new Error(`no service ${name}`);
			return found;
		};
		const route = contribution.http?.[0];
		if (!route) throw new Error("no route");
		return {
			fake,
			plugin,
			contribution,
			service,
			route,
			port: provided as LineBridgePort,
		};
	};

	beforeEach(async () => {
		sql ??= await freshPool();
		await sql`TRUNCATE line_inbox, line_sources`;
		logs.lines.length = 0;
		provided = undefined;
	});
	afterAll(async () => {
		await sql?.close();
	});

	test("it contributes the webhook route, two services and the LINE service, and declares its migration", async () => {
		const { plugin, contribution, route, port } = await boot();
		expect(plugin.name).toBe("line");
		expect(plugin.provides).toEqual([LINE]);
		expect(plugin.migrations?.map((m) => m.name)).toEqual(["inbox"]);
		expect(contribution.services?.map((s) => s.name)).toEqual([
			"line-bot",
			"line-inbox",
		]);
		expect(route).toMatchObject({
			name: "line-webhook",
			listener: "public",
			path: { exact: "/line/webhook" },
			methods: ["POST"],
		});
		expect(Object.keys(port).sort()).toEqual([
			"attachProcessor",
			"botUserId",
			"health",
			"sources",
		]);
		const custom = await boot({ webhookPath: "/hooks/line", listener: "edge" });
		expect(custom.route).toMatchObject({
			listener: "edge",
			path: { exact: "/hooks/line" },
		});
	});

	test("a signed event of an allowed chat travels webhook to inbox to the attached processor", async () => {
		const { fake, service, route, port } = await boot();
		await service("line-bot").startInBackground?.();
		expect(port.botUserId()).toBe(BOT);
		await service("line-inbox").start?.();
		const got: InboxEvent[] = [];
		const detach = port.attachProcessor(async (event) => {
			got.push(event);
			return undefined;
		});
		expect(() => port.attachProcessor(async () => undefined)).toThrow(
			"already attached",
		);

		// The first message is from an unknown chat: pending, nothing kept.
		expect(
			(await route.handle(webhookRequest(body(messageEvent({ id: "m1" })))))
				.status,
		).toBe(200);
		expect((await port.sources.pending()).map((s) => s.key)).toEqual([GROUP]);
		await port.sources.allow(GROUP);
		const raw = body(messageEvent({ id: "m2", text: "second" }));
		expect((await route.handle(webhookRequest(raw))).status).toBe(200);
		// A forged signature does not get in.
		expect(
			(
				await route.handle(
					webhookRequest(raw, { signature: sign(raw, "other") }),
				)
			).status,
		).toBe(401);
		for (let i = 0; i < 400 && got.length < 1; i++) await Bun.sleep(10);
		expect(got.map((e) => e.id)).toEqual(["m2"]);
		expect(got[0]?.payload).toMatchObject({ message: { text: "second" } });
		expect(port.health()).toEqual({ tokensIssued: 1, tokenFailure: undefined });
		expect(fake.issued).toHaveLength(1);

		detach();
		await service("line-inbox").stop?.();
		expect(service("line-inbox").busy?.()).toEqual([]);
	});

	test("the token and the secret appear in no log line and no error, through a whole run and through failures", async () => {
		const { fake, service, route, port } = await boot();
		fake.failTokens(500);
		await service("line-bot").startInBackground?.();
		expect(port.botUserId()).toBeUndefined();
		expect(port.health().tokenFailure).toBe("token_refused");
		fake.failTokens(undefined);
		await service("line-bot").startInBackground?.();
		expect(port.botUserId()).toBe(BOT);
		fake.breakNetwork(true);
		const errors: string[] = [];
		await port.sources
			.summary(GROUP)
			.catch((e: unknown) => errors.push(String(e)));
		fake.breakNetwork(false);
		await route.handle(webhookRequest(body(messageEvent({ id: "m1" }))));
		await route.handle(webhookRequest("{}", { signature: "bad" }));
		await route.handle(webhookRequest("not json"));
		const secrets = [SECRET, ...fake.issued, "access-token-"];
		const everything =
			JSON.stringify(logs.lines) + errors.join("\n") + JSON.stringify(port);
		for (const secret of secrets) expect(everything).not.toContain(secret);
		// There were lines to look at.
		expect(logs.lines.length).toBeGreaterThan(3);
		expect(logs.lines.some((l) => l.fields.code === "token_refused")).toBe(
			true,
		);
	});
});
