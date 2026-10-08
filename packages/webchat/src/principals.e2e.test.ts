import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createFauxCore,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	BACKGROUND_TURNS,
	CONVERSATIONS,
	definePlugin,
	defineRoundtable,
	IDENTITY,
	MEMORY,
	type PluginContext,
	Roundtable,
	SCHEDULES,
} from "pi-roundtable";
import {
	describeDb,
	silentLogger,
	testDatabaseUrl,
} from "pi-roundtable/testing";
import { Type } from "typebox";
import { oidcJwtVerifier, oidcSpeakerId } from "./oidc.ts";
import { webChat } from "./plugin.ts";
import { type ServerFrame, WEBCHAT_PROTOCOL } from "./protocol.ts";
import { testIssuer } from "./testing/issuer.ts";

const ORIGIN = "https://chat.example.test";
const tool = (
	name: string,
	args: Record<string, string | number>,
): FauxResponseStep =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

async function fixture() {
	const idp = await testIssuer();
	const dir = mkdtempSync(join(tmpdir(), "webchat-principals-"));
	const core = createFauxCore({ provider: "faux", models: [{ id: "faux-1" }] });
	const runtime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	runtime.registerProvider("faux", {
		api: core.api,
		apiKey: "test",
		baseUrl: "http://faux.invalid",
		streamSimple: core.streamSimple,
		models: [
			{
				id: "faux-1",
				name: "Faux",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 1_000,
			},
		],
	});
	const probe = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response(),
	});
	const port = probe.port ?? 0;
	probe.stop(true);
	let context: PluginContext | undefined;
	const { options, plugins } = await defineRoundtable(
		{
			name: "Test",
			access: {
				owners: [{ principal: "operator", name: "Operator" }],
				members: { roles: ["web:role:Chat.User"], everyone: ["discord"] },
			},
			database: { url: testDatabaseUrl },
			dataDir: dir,
			model: "faux/faux-1",
			judge: { model: "faux/judge" },
			toolTiers: { notify: "member", schedule_create: "member" },
			plugins: [
				webChat({
					verifier: oidcJwtVerifier({
						jwksUrl: idp.jwksUrl,
						issuers: [idp.issuer],
						audiences: [idp.audience],
					}),
					origins: [ORIGIN],
					personas: [
						{
							kind: "helper",
							prompt: () => "Help the person privately.",
							selection: {
								tools: [
									"memory_add",
									"memory_search",
									"schedule_create",
									"schedule_list",
									"notify",
								],
								groups: [],
							},
						},
					],
				}),
				definePlugin({
					name: "probe",
					setup: (given) => {
						context = given;
						return {
							sessionTools: [
								{
									name: "compactor",
									phase: "tools",
									snapshot: () => ({
										revision: 0,
										factory: () => (pi) => {
											pi.registerTool({
												name: "compact_session",
												label: "compact_session",
												description: "Compact.",
												parameters: Type.Object({}),
												execute: async () => {
													throw new Error("not scripted");
												},
											});
										},
									}),
								},
							],
						};
					},
				}),
			],
		},
		{
			logger: silentLogger(),
			modelRuntime: runtime,
			listeners: [{ id: "public", port, hostname: "127.0.0.1" }],
		},
	);
	const host = new Roundtable(options, plugins);
	await host.run();
	if (!context) throw new Error("no plugin context");
	const ctx: PluginContext = context;
	const sockets: WebSocket[] = [];
	const api = (token: string, path: string, method = "GET") =>
		fetch(`http://127.0.0.1:${port}/chat/${path}`, {
			method,
			headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
		});
	async function browser(token: string) {
		const issued = await api(token, "tickets", "POST");
		expect(issued.status).toBe(201);
		const { ticket } = (await issued.json()) as { ticket: string };
		const socket = new WebSocket(`ws://127.0.0.1:${port}/chat/socket`, {
			headers: { origin: ORIGIN },
			protocols: [WEBCHAT_PROTOCOL, `ticket.${ticket}`],
		} as unknown as string[]);
		sockets.push(socket);
		const frames: ServerFrame[] = [];
		socket.addEventListener("message", (event) =>
			frames.push(JSON.parse(String(event.data)) as ServerFrame),
		);
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve());
			socket.addEventListener("error", () => reject(new Error("no socket")));
		});
		const until = async (done: (frames: ServerFrame[]) => boolean) => {
			const start = Date.now();
			while (!done(frames)) {
				if (Date.now() - start > 5_000)
					throw new Error(`timed out: ${JSON.stringify(frames)}`);
				await Bun.sleep(10);
			}
		};
		await until((frames) => frames.some((f) => f.type === "ready"));
		const ready = frames.find((f) => f.type === "ready");
		if (ready?.type !== "ready") throw new Error("no ready");
		return {
			frames,
			until,
			speaker: ready.speaker,
			close: () =>
				new Promise<void>((resolve) => {
					socket.addEventListener("close", () => resolve(), { once: true });
					socket.close();
				}),
			send: (frame: object) => socket.send(JSON.stringify(frame)),
		};
	}
	const stop = async () => {
		for (const socket of sockets) socket.close();
		await host.shutdown("test");
		await idp.close();
		rmSync(dir, { recursive: true, force: true });
	};
	return { idp, core, ctx, api, browser, stop, dir };
}

describeDb("webchat core principals with a self-built JWKS", () => {
	test("A/B have separate memory, schedules and inboxes, and scheduled replies reach only their owner", async () => {
		const h = await fixture();
		try {
			const tokenA = await h.idp.sign({
				claims: { sub: `a-${crypto.randomUUID()}`, name: "Ada" },
			});
			const tokenB = await h.idp.sign({
				claims: { sub: `b-${crypto.randomUUID()}`, name: "Bo" },
			});
			const a = await h.browser(tokenA);
			const b = await h.browser(tokenB);
			expect(a.speaker.principalId).toStartWith("p_");
			expect(b.speaker.principalId).toStartWith("p_");
			expect(a.speaker.principalId).not.toBe(b.speaker.principalId);
			const memory = h.ctx.services.get(MEMORY);
			const schedules = h.ctx.services.get(SCHEDULES);
			const run = async (who: typeof a, secret: string, label: string) => {
				h.core.setResponses([
					tool("memory_add", { fact: secret, kind: "core" }),
					tool("schedule_create", {
						title: `${label}'s reminder`,
						prompt: `remind ${label}`,
						in_minutes: 10,
					}),
					tool("notify", { text: `${label}'s private notice` }),
					fauxAssistantMessage(`saved ${label}`),
				]);
				who.send({
					type: "send",
					id: label,
					persona: "helper",
					text: "Remember this, schedule a reminder and notify me.",
				});
				await who.until((frames) => frames.some((f) => f.type === "reply"));
				const accepted = who.frames.find((f) => f.type === "accepted");
				if (accepted?.type !== "accepted") throw new Error("no accepted");
				return accepted.conversation;
			};
			const conversationA = await run(a, "SECRET_A amber otter", "Ada");
			const conversationB = await run(b, "SECRET_B blue crane", "Bo");
			expect(
				(await memory.forSpeaker(a.speaker.principalId).list()).map(
					(m) => m.fact,
				),
			).toEqual(["SECRET_A amber otter"]);
			expect(
				(await memory.forSpeaker(b.speaker.principalId).list()).map(
					(m) => m.fact,
				),
			).toEqual(["SECRET_B blue crane"]);
			for (const [who, mine, other, conversation] of [
				[a, "SECRET_A", "SECRET_B", conversationA],
				[b, "SECRET_B", "SECRET_A", conversationB],
			] as const) {
				let seen: TranscriptContext | undefined;
				h.core.setResponses([
					tool("memory_search", { query: "SECRET_A SECRET_B" }),
					(context) => {
						seen = context;
						return fauxAssistantMessage("checked");
					},
				]);
				const count = who.frames.filter((f) => f.type === "reply").length;
				who.send({
					type: "send",
					id: "check",
					conversation,
					text: "Search my memory",
				});
				await who.until(
					(f) => f.filter((x) => x.type === "reply").length > count,
				);
				expect(JSON.stringify(seen)).toContain(mine);
				expect(JSON.stringify(seen)).not.toContain(
					`${other} ${other === "SECRET_A" ? "amber otter" : "blue crane"}`,
				);
			}
			const noticesA = (await (await h.api(tokenA, "notices")).json()) as {
				notices: { id: string; text: string; readAt: string | null }[];
			};
			const noticesB = (await (
				await h.api(tokenB, "notices")
			).json()) as typeof noticesA;
			expect(noticesA.notices.map((n) => n.text)).toEqual([
				"Ada's private notice",
			]);
			expect(noticesB.notices.map((n) => n.text)).toEqual([
				"Bo's private notice",
			]);
			expect(a.frames.filter((f) => f.type === "notice")).toHaveLength(1);
			expect(b.frames.filter((f) => f.type === "notice")).toHaveLength(1);
			const noticeId = noticesA.notices[0]?.id ?? "";
			expect(
				(await h.api(tokenB, `notices/${noticeId}/read`, "POST")).status,
			).toBe(404);
			expect(
				(await h.api(tokenA, `notices/${noticeId}/read`, "POST")).status,
			).toBe(200);
			expect(
				(await h.api(tokenA, "notices/not-a-uuid/read", "POST")).status,
			).toBe(400);
			const listedB = (await (await h.api(tokenB, "conversations")).json()) as {
				conversations: { conversation: string }[];
			};
			expect(listedB.conversations.map((c) => c.conversation)).not.toContain(
				conversationA,
			);
			expect(
				(await h.api(tokenB, `conversations/${conversationA}/messages`)).status,
			).toBe(403);
			b.send({
				type: "send",
				id: "intrude",
				conversation: conversationA,
				text: "let me in",
			});
			await b.until((f) =>
				f.some((x) => x.type === "error" && x.ref === "intrude"),
			);
			expect(b.frames.at(-1)).toMatchObject({
				type: "error",
				code: "forbidden",
			});
			const scheduleA = (await schedules.forChannel(`web:${conversationA}`))[0];
			const scheduleB = (await schedules.forChannel(`web:${conversationB}`))[0];
			expect(scheduleA?.createdById).toBe(a.speaker.principalId);
			expect(scheduleB?.createdById).toBe(b.speaker.principalId);
			if (!scheduleA || !scheduleB) throw new Error("no schedules created");
			for (const [schedule, recipient, other] of [
				[scheduleA, a, b],
				[scheduleB, b, a],
			] as const) {
				const before = other.frames.length;
				h.core.setResponses([
					fauxAssistantMessage(`scheduled for ${schedule.createdByName}`),
				]);
				expect(
					await h.ctx.services
						.get(BACKGROUND_TURNS)
						.runScheduled(schedule, new Date()),
				).toEqual({ status: "ran" });
				await recipient.until((f) =>
					f.some(
						(x) =>
							x.type === "reply" &&
							x.text === `scheduled for ${schedule.createdByName}`,
					),
				);
				expect(
					other.frames
						.slice(before)
						.some((f) => f.type === "reply" || f.type === "progress"),
				).toBe(false);
				await schedules.remove(schedule.id);
			}
			// Offline notices remain available through REST, not in the transcript.
			await a.close();
			expect(
				await h.ctx.directChannels.notify(
					a.speaker.principalId,
					"later notice",
				),
			).toBe(true);
			const transcript = await (
				await h.api(tokenA, `conversations/${conversationA}/messages`)
			).json();
			expect(JSON.stringify(transcript)).not.toContain("later notice");
			const offline = (await (
				await h.api(tokenA, "notices")
			).json()) as typeof noticesA;
			expect(offline.notices[0]?.text).toBe("later notice");
			const page = (await (
				await h.api(tokenA, `notices?limit=1&before=${offline.notices[0]?.id}`)
			).json()) as typeof noticesA;
			expect(page.notices.map((n) => n.text)).toEqual(["Ada's private notice"]);
		} finally {
			await h.stop();
		}
	}, 30_000);

	test("M1's backfilled oidc owner keeps their conversation without rewriting it; CLI linking Discord then web shares memory", async () => {
		const h = await fixture();
		try {
			const subject = `legacy-${crypto.randomUUID()}`;
			const legacyId = oidcSpeakerId(h.idp.issuer, subject);
			const sql = h.ctx.database();
			// Simulates the backfill's claimable principal plus M1's unchanged private registry row.
			await sql`INSERT INTO principals (id, display_name, claimable) VALUES (${legacyId}, ${legacyId}, true)`;
			const old = crypto.randomUUID();
			const registry = h.ctx.services.get(CONVERSATIONS);
			const before = await registry.register({
				key: `web:${old}`,
				kind: "helper",
				visibility: "private",
				principalId: legacyId,
				title: "M1 history",
			});
			const legacyToken = await h.idp.sign({
				claims: { sub: subject, name: "Legacy person" },
			});
			const legacy = await h.browser(legacyToken);
			expect(legacy.speaker.principalId).toBe(legacyId);
			expect(await registry.get(`web:${old}`)).toEqual(before);
			const listed = (await (
				await h.api(legacyToken, "conversations")
			).json()) as { conversations: { conversation: string }[] };
			expect(listed.conversations.map((c) => c.conversation)).toContain(old);
			h.core.setResponses([fauxAssistantMessage("still yours")]);
			legacy.send({
				type: "send",
				id: "old",
				conversation: old,
				text: "continue",
			});
			await legacy.until((f) =>
				f.some((x) => x.type === "reply" && x.text === "still yours"),
			);
			expect((await registry.get(`web:${old}`))?.principalId).toBe(legacyId);

			const identity = h.ctx.services.get(IDENTITY);
			const discordId = `discord-test-${crypto.randomUUID()}`;
			const discord = await identity.resolve({
				provider: "discord",
				subject: discordId,
				name: "Linked person",
				legacyId: discordId,
			});
			if (!discord) throw new Error("Discord person not admitted");
			h.core.setResponses([
				tool("memory_add", { fact: "LINKED_MEMORY copper fox", kind: "core" }),
				fauxAssistantMessage("remembered on Discord"),
			]);
			await h.ctx.turns.run({
				channel: `discord:${crypto.randomUUID()}`,
				kind: "helper",
				speaker: discord,
				text: "remember this",
				conversation: { visibility: "private" },
				selection: { id: "linked", tools: ["memory_add"], groups: [] },
				reply: async () => {},
			});
			const webSubject = `linked-${crypto.randomUUID()}`;
			const webIdentity = oidcSpeakerId(h.idp.issuer, webSubject);
			writeFileSync(
				join(h.dir, "roundtable.config.ts"),
				`export default ${JSON.stringify({ access: { owners: [{ principal: "operator", name: "Operator" }], members: { everyone: true } }, database: { url: testDatabaseUrl }, dataDir: h.dir, model: "faux/faux-1" })};`,
			);
			const command = Bun.spawn(
				[
					"bun",
					resolve(import.meta.dir, "../../../src/cli/roundtable.mjs"),
					"principal",
					"link",
					discord.principalId,
					webIdentity,
				],
				{ cwd: h.dir, stdout: "pipe", stderr: "pipe" },
			);
			const output = await new Response(command.stdout).text();
			const errors = await new Response(command.stderr).text();
			expect(await command.exited).toBe(0);
			expect(`${output}${errors}`).toContain(discord.principalId);
			const webToken = await h.idp.sign({
				claims: { sub: webSubject, name: "Linked person" },
			});
			const web = await h.browser(webToken);
			expect(web.speaker.principalId).toBe(discord.principalId);
			let seen: TranscriptContext | undefined;
			h.core.setResponses([
				(context) => {
					seen = context;
					return fauxAssistantMessage("same memory");
				},
			]);
			web.send({
				type: "send",
				id: "linked",
				persona: "helper",
				text: "what do you remember?",
			});
			await web.until((f) => f.some((x) => x.type === "reply"));
			expect(JSON.stringify(seen)).toContain("LINKED_MEMORY copper fox");
		} finally {
			await h.stop();
		}
	}, 30_000);
});
