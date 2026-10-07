import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	CONVERSATIONS,
	definePlugin,
	defineRoundtable,
	defineTool,
	type PluginContext,
	Roundtable,
} from "pi-roundtable";
import {
	describeDb,
	silentLogger,
	testDatabaseUrl,
} from "pi-roundtable/testing";
import { Type } from "typebox";
import { oidcJwtVerifier, oidcSpeakerId } from "./oidc.ts";
import { webChat } from "./plugin.ts";
import {
	type ServerFrame,
	TICKET_PROTOCOL_PREFIX,
	WEBCHAT_PROTOCOL,
} from "./protocol.ts";
import { type TestIssuer, testIssuer } from "./testing/issuer.ts";

const ORIGIN = "https://chat.example.test";

let idp: TestIssuer;
let roundtable: Roundtable | undefined;
let context: PluginContext | undefined;
let port = 0;
let dataDir = "";
const sent: string[] = [];

/** A port nothing listens on, for the host's listener. */
function freePort(): number {
	const probe = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	const found = probe.port ?? 0;
	probe.stop(true);
	return found;
}

/** The faux model's script: look, ask to send a note (held for approval), then answer. */
async function fauxModel(dir: string): Promise<ModelRuntime> {
	const core = createFauxCore({ provider: "faux", models: [{ id: "faux-1" }] });
	core.setResponses([
		fauxAssistantMessage(
			[
				fauxText("Checking the notes."),
				fauxToolCall("note_send", { to: "team" }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage([fauxText("Sent the note to the team.")]),
	]);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerProvider("faux", {
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
	return modelRuntime;
}

/**
 * A tool members may use whose every call waits for approval, and the compaction tool the host
 * requires, which a deployment gets from a Pi package such as pi-self-compact.
 */
const notes = definePlugin({
	name: "notes",
	setup: () => ({
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
							description: "Compact the session.",
							parameters: Type.Object({}),
							execute: async () => {
								throw new Error("not scripted");
							},
						});
					},
				}),
			},
		],
		tools: [
			defineTool({
				name: "note_send",
				description: "Send a note to someone.",
				parameters: Type.Object({ to: Type.String() }),
				minTier: "member",
				hold: ({ to }) => `send a note to ${to}`,
				run: ({ to }) => {
					sent.push(to);
					return `Sent to ${to}.`;
				},
			}),
		],
	}),
});

describeDb("a host whose only surface is the web chat", () => {
	beforeAll(async () => {
		idp = await testIssuer();
		dataDir = mkdtempSync(join(tmpdir(), "webchat-e2e-"));
		port = freePort();
		const { options, plugins } = await defineRoundtable(
			{
				name: "Helpdesk",
				owner: { id: "operator", name: "Operator" },
				database: { url: testDatabaseUrl },
				dataDir,
				model: "faux/faux-1",
				// No such model: the effort judge falls back instead of taking the faux script's answers.
				judge: { model: "faux/judge" },
				memory: false,
				plugins: [
					notes,
					webChat({
						verifier: oidcJwtVerifier({
							jwksUrl: idp.jwksUrl,
							issuers: [idp.issuer],
							audiences: [idp.audience],
						}),
						access: { members: { roles: ["Chat.User"] } },
						origins: [ORIGIN],
						personas: [
							{
								kind: "helpdesk",
								label: "Helpdesk",
								prompt: () => "You help with notes.",
								selection: { tools: ["note_send"], groups: [] },
							},
						],
					}),
					definePlugin({
						name: "probe",
						setup: (given) => {
							context = given;
							return { services: [{ name: "probe" }] };
						},
					}),
				],
			},
			{
				logger: silentLogger(),
				modelRuntime: await fauxModel(dataDir),
				listeners: [{ id: "public", port, hostname: "127.0.0.1" }],
			},
		);
		roundtable = new Roundtable(options, plugins);
		await roundtable.run();
	});

	afterAll(async () => {
		await roundtable?.shutdown("test");
		await idp.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	const api = (path: string, init: RequestInit & { token?: string } = {}) =>
		fetch(`http://127.0.0.1:${port}/chat/${path}`, {
			...init,
			headers: {
				origin: ORIGIN,
				...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
				...(init.headers as Record<string, string>),
			},
		});

	/** The status of a WebSocket handshake, read as plain HTTP. */
	const handshake = async (headers: Record<string, string>) =>
		(
			await fetch(`http://127.0.0.1:${port}/chat/socket`, {
				headers: {
					connection: "Upgrade",
					upgrade: "websocket",
					"sec-websocket-version": "13",
					"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
					"sec-websocket-protocol": WEBCHAT_PROTOCOL,
					...headers,
				},
			})
		).status;

	/** A browser's socket: a ticket from the API, spent in the subprotocol. */
	async function browser(token: string) {
		const response = await api("tickets", { method: "POST", token });
		expect(response.status).toBe(201);
		const { ticket } = (await response.json()) as { ticket: string };
		const socket = new WebSocket(`ws://127.0.0.1:${port}/chat/socket`, {
			headers: { origin: ORIGIN },
			protocols: [WEBCHAT_PROTOCOL, `${TICKET_PROTOCOL_PREFIX}${ticket}`],
		} as unknown as string[]);
		const frames: ServerFrame[] = [];
		socket.addEventListener("message", (event) => {
			frames.push(JSON.parse(String(event.data)) as ServerFrame);
		});
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve());
			socket.addEventListener("error", () => reject(new Error("no socket")));
		});
		const until = async (done: (frames: ServerFrame[]) => boolean) => {
			for (let waited = 0; !done(frames); waited += 10) {
				if (waited > 5000)
					throw new Error(`timed out: ${JSON.stringify(frames)}`);
				await Bun.sleep(10);
			}
		};
		return {
			socket,
			frames,
			until,
			send: (frame: object) => socket.send(JSON.stringify(frame)),
		};
	}

	test("a member connects, runs a turn on the model, sees its progress, approves its held call, and gets the answer", async () => {
		// Subjects of their own, so a database other runs used still holds none of their conversations.
		const adaSub = `ada-${crypto.randomUUID()}`;
		const eveSub = `eve-${crypto.randomUUID()}`;
		const token = await idp.sign({ claims: { sub: adaSub, name: "Ada" } });
		const ada = await browser(token);
		expect(ada.socket.protocol).toBe(WEBCHAT_PROTOCOL);
		await ada.until((f) => f.some((frame) => frame.type === "ready"));
		expect(ada.frames[0]).toMatchObject({
			type: "ready",
			protocol: 1,
			speaker: {
				id: oidcSpeakerId(idp.issuer, adaSub),
				name: "Ada",
				tier: "member",
			},
			personas: [{ kind: "helpdesk", label: "Helpdesk" }],
		});
		ada.send({
			type: "send",
			id: "m1",
			persona: "helpdesk",
			text: "Send the team a note",
		});
		await ada.until((f) => f.some((frame) => frame.type === "prompt"));
		const prompt = ada.frames.find((frame) => frame.type === "prompt");
		if (prompt?.type !== "prompt") throw new Error("no prompt");
		expect(prompt.prompt).toMatchObject({ kind: "approval" });
		expect(
			prompt.prompt.kind === "approval" && prompt.prompt.message,
		).toContain("send a note to team");
		expect(sent).toEqual([]);
		ada.send({ type: "approval", prompt: prompt.prompt.id, approved: true });
		await ada.until((f) => f.some((frame) => frame.type === "reply"));
		const accepted = ada.frames.find((frame) => frame.type === "accepted");
		if (accepted?.type !== "accepted") throw new Error("not accepted");
		const { conversation } = accepted;
		expect(sent).toEqual(["team"]);
		const types = ada.frames.map((frame) => frame.type);
		expect(types).toContain("typing");
		expect(types).toContain("stoppable");
		const progress = ada.frames.flatMap((frame) =>
			frame.type === "progress" ? [frame.event] : [],
		);
		expect(progress[0]).toEqual({ type: "text", delta: "Checking the notes." });
		expect(
			progress.some((e) => e.type === "tool_start" && e.tool === "note_send"),
		).toBe(true);
		expect(progress.some((e) => e.type === "tool_end" && e.ok)).toBe(true);
		expect(ada.frames.find((frame) => frame.type === "reply")).toEqual({
			type: "reply",
			conversation,
			text: "Sent the note to the team.",
		});
		expect(types.indexOf("prompt_closed")).toBeLessThan(types.indexOf("reply"));
		// The registry records the conversation as hers, and the API lists it and its transcript.
		const record = await context?.services
			.get(CONVERSATIONS)
			.get(`web:${conversation}`);
		expect(record).toMatchObject({
			kind: "helpdesk",
			visibility: "private",
			principalId: oidcSpeakerId(idp.issuer, adaSub),
			title: "Send the team a note",
		});
		const listed = (await (await api("conversations", { token })).json()) as {
			conversations: { conversation: string; persona: string; title: string }[];
		};
		expect(listed.conversations).toMatchObject([
			{ conversation, persona: "helpdesk", title: "Send the team a note" },
		]);
		const transcript = (await (
			await api(`conversations/${conversation}/messages`, { token })
		).json()) as { messages: { role: string; text: string }[] };
		expect(transcript.messages.at(0)).toMatchObject({ role: "user" });
		expect(transcript.messages.at(-1)).toEqual({
			role: "assistant",
			text: "Sent the note to the team.",
		});

		// Someone else is refused everywhere in her conversation.
		const eveToken = await idp.sign({ claims: { sub: eveSub, name: "Eve" } });
		const eve = await browser(eveToken);
		await eve.until((f) => f.some((frame) => frame.type === "ready"));
		eve.send({ type: "send", id: "e1", conversation, text: "let me read it" });
		eve.send({ type: "stop", conversation });
		await eve.until(
			(f) => f.filter((frame) => frame.type === "error").length >= 2,
		);
		expect(eve.frames.filter((frame) => frame.type === "error")).toEqual([
			{ type: "error", code: "forbidden", ref: "e1" },
			{ type: "error", code: "forbidden" },
		]);
		expect(eve.frames.some((frame) => frame.type === "reply")).toBe(false);
		expect(
			(await api(`conversations/${conversation}/messages`, { token: eveToken }))
				.status,
		).toBe(403);
		expect(
			(await (
				await api("conversations", { token: eveToken })
			).json()) as object,
		).toEqual({ conversations: [] });
		ada.socket.close();
		eve.socket.close();
	});

	test("a wrong Origin, a missing or spent ticket, and a refused token never open a socket", async () => {
		const token = await idp.sign({ claims: { sub: "ada" } });
		const auth = { authorization: `Bearer ${token}` };
		expect(await handshake({ origin: ORIGIN, ...auth })).toBe(101);
		expect(
			await handshake({ origin: "https://evil.example.test", ...auth }),
		).toBe(403);
		expect(await handshake(auth)).toBe(403);
		expect(await handshake({ origin: ORIGIN })).toBe(401);
		const { ticket } = (await (
			await api("tickets", { method: "POST", token })
		).json()) as { ticket: string };
		const withTicket = {
			origin: ORIGIN,
			"sec-websocket-protocol": `${WEBCHAT_PROTOCOL}, ${TICKET_PROTOCOL_PREFIX}${ticket}`,
		};
		expect(await handshake(withTicket)).toBe(101);
		expect(await handshake(withTicket)).toBe(401);
		expect(
			await handshake({
				origin: ORIGIN,
				...auth,
				"sec-websocket-protocol": "other",
			}),
		).toBe(400);
		const now = Math.floor(Date.now() / 1000);
		const expired = await idp.sign({ claims: { sub: "ada", exp: now - 120 } });
		const otherAudience = await idp.sign({
			claims: { sub: "ada", aud: "api://other" },
		});
		const noRole = await idp.sign({ claims: { sub: "ada", roles: [] } });
		for (const bad of [expired, otherAudience])
			expect(
				await handshake({ origin: ORIGIN, authorization: `Bearer ${bad}` }),
			).toBe(401);
		expect(
			await handshake({ origin: ORIGIN, authorization: `Bearer ${noRole}` }),
		).toBe(403);
	});

	test("the API refuses a missing or refused token, another origin, and answers its own origin's preflight", async () => {
		const now = Math.floor(Date.now() / 1000);
		expect((await api("conversations")).status).toBe(401);
		const expired = await idp.sign({ claims: { exp: now - 120 } });
		const otherAudience = await idp.sign({ claims: { aud: "api://other" } });
		for (const bad of [expired, otherAudience]) {
			const response = await api("conversations", { token: bad });
			expect(response.status).toBe(401);
			expect(response.headers.get("www-authenticate")).toBe("Bearer");
		}
		const token = await idp.sign();
		expect(
			(
				await api("conversations", {
					token,
					headers: { origin: "https://evil.example.test" },
				})
			).status,
		).toBe(403);
		const preflight = await api("conversations", { method: "OPTIONS" });
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-origin")).toBe(ORIGIN);
		expect(preflight.headers.get("access-control-allow-headers")).toContain(
			"authorization",
		);
		const opened = await api("conversations", {
			method: "POST",
			token,
			body: JSON.stringify({ persona: "helpdesk", title: "Later" }),
		});
		expect(opened.status).toBe(201);
		expect(
			(
				await api("conversations", {
					method: "POST",
					token,
					body: JSON.stringify({ persona: "owner" }),
				})
			).status,
		).toBe(404);
	});
});
