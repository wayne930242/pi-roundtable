import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	definePlugin,
	defineRoundtable,
	defineTool,
	Roundtable,
	ToolRefusal,
} from "pi-roundtable";
import {
	describeDb,
	silentLogger,
	testDatabaseUrl,
} from "pi-roundtable/testing";
import { Type } from "typebox";
import { oidcJwtVerifier } from "./oidc.ts";
import { webChat } from "./plugin.ts";
import {
	type ServerFrame,
	TICKET_PROTOCOL_PREFIX,
	WEBCHAT_PROTOCOL,
} from "./protocol.ts";
import { type TestIssuer, testIssuer } from "./testing/issuer.ts";

const ORIGIN = "https://chat.example.test";
const text = (value: string) => new TextEncoder().encode(value);

let idp: TestIssuer;
let roundtable: Roundtable | undefined;
let port = 0;
let dataDir = "";
let script: ReturnType<typeof createFauxCore>;
/** What the model saw of the turn's user message and of the tool results, in request order. */
const seen: { user: unknown; results: string[] }[] = [];

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

async function fauxModel(dir: string): Promise<ModelRuntime> {
	script = createFauxCore({ provider: "faux", models: [{ id: "faux-1" }] });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerProvider("faux", {
		api: script.api,
		apiKey: "test",
		baseUrl: "http://faux.invalid",
		streamSimple: script.streamSimple,
		models: [
			{
				id: "faux-1",
				name: "Faux",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 1_000,
			},
		],
	});
	return modelRuntime;
}

/** A model step that records what it was sent, then calls a tool or answers. */
function step(call?: { tool: string; args: Record<string, string> }) {
	return (request: TranscriptContext) => {
		const user = request.messages.findLast((m) => m.role === "user")?.content;
		const results = request.messages
			.filter((m) => m.role === "toolResult")
			.map((m) =>
				m.content
					.map((part) => (part.type === "text" ? part.text : ""))
					.join(""),
			);
		seen.push({ user, results });
		return call
			? fauxAssistantMessage([fauxToolCall(call.tool, call.args)], {
					stopReason: "toolUse",
				})
			: fauxAssistantMessage("Looked at it.");
	};
}

/** A tool that hands a user's file on: it reads the conversation's attachment by name. */
const probe = definePlugin({
	name: "file-probe",
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
				name: "file_probe",
				description: "Read an attached file's bytes.",
				parameters: Type.Object({ file: Type.String() }),
				minTier: "member",
				run: async ({ file }, turn) => {
					try {
						const attachment = await turn.attachment(file);
						return new TextDecoder().decode(await attachment.bytes());
					} catch (error) {
						if (error instanceof ToolRefusal)
							return `refused: ${error.message}`;
						throw error;
					}
				},
			}),
		],
	}),
});

describeDb("web chat attachments under a retention period", () => {
	beforeAll(async () => {
		idp = await testIssuer();
		dataDir = mkdtempSync(join(tmpdir(), "webchat-retention-"));
		port = freePort();
		const { options, plugins } = await defineRoundtable(
			{
				name: "Helpdesk",
				access: {
					owners: [{ principal: "operator", name: "Operator" }],
					members: { roles: ["web:role:Chat.User"] },
				},
				database: { url: testDatabaseUrl },
				dataDir,
				attachments: { retention: { maxAgeMs: 400, sweepEveryMs: 100 } },
				model: "faux/faux-1",
				judge: { model: "faux/judge" },
				memory: false,
				plugins: [
					probe,
					webChat({
						verifier: oidcJwtVerifier({
							jwksUrl: idp.jwksUrl,
							issuers: [idp.issuer],
							audiences: [idp.audience],
						}),
						origins: [ORIGIN],
						personas: [
							{
								kind: "helpdesk",
								label: "Helpdesk",
								prompt: () => "You help with files.",
								selection: {
									tools: ["file_probe", "read_attachment"],
									groups: [],
								},
							},
						],
						limits: {
							attachmentBytes: 2048,
							usedAttachmentBytesPerPrincipal: 20,
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

	async function browser(token: string) {
		const response = await api("tickets", { method: "POST", token });
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
				if (waited > 8000)
					throw new Error(`timed out: ${JSON.stringify(frames)}`);
				await Bun.sleep(10);
			}
		};
		await until((f) => f.some((frame) => frame.type === "ready"));
		return {
			socket,
			frames,
			until,
			send: (frame: object) => socket.send(JSON.stringify(frame)),
		};
	}

	test("a used file is removed after the period: the tool and the model are told so, the allowance is back, and the disk keeps no copy", async () => {
		const token = await idp.sign({
			claims: { sub: `ada-${crypto.randomUUID()}`, name: "Ada" },
		});
		const opened = await api("conversations", {
			method: "POST",
			token,
			body: JSON.stringify({ persona: "helpdesk" }),
		});
		const { conversation } = (await opened.json()) as { conversation: string };
		const upload = async (body: string, name: string) => {
			const response = await api(
				`conversations/${conversation}/files?name=${name}`,
				{
					method: "POST",
					token,
					headers: { "content-type": "text/plain" },
					body: text(body),
				},
			);
			expect(response.status).toBe(201);
			return ((await response.json()) as { file: string }).file;
		};
		const first = await upload("0123456789012345", "private-notes.txt");
		const socket = await browser(token);
		script.setResponses([
			step({ tool: "file_probe", args: { file: first } }),
			step(),
		]);
		seen.length = 0;
		socket.send({
			type: "send",
			id: "m1",
			conversation,
			text: "read it",
			attachments: [first],
		});
		await socket.until((f) => f.some((frame) => frame.type === "reply"));
		// Fresh: the tool reads it.
		expect(seen[1]?.results.join("")).toContain("0123456789012345");
		// 16 of the 20 bytes are in use, so another 16 are over the allowance.
		const second = await upload("abcdefghijklmnop", "more.txt");
		socket.send({
			type: "send",
			id: "m2",
			conversation,
			text: "and this",
			attachments: [second],
		});
		await socket.until((f) => f.some((frame) => frame.type === "error"));
		expect(socket.frames.find((frame) => frame.type === "error")).toMatchObject(
			{
				code: "attachment_quota",
			},
		);
		// The retention period (400 ms) passes and the sweep (every 100 ms) runs.
		await Bun.sleep(900);
		const kept = readdirSync(join(dataDir, "attachments"), { recursive: true });
		expect(
			kept.some((entry) => String(entry).endsWith("private-notes.txt")),
		).toBe(false);
		seen.length = 0;
		script.setResponses([
			step({ tool: "file_probe", args: { file: first } }),
			step({ tool: "read_attachment", args: { file: first } }),
			step(),
		]);
		socket.send({
			type: "send",
			id: "m3",
			conversation,
			text: "read the first again",
			attachments: [second],
		});
		await socket.until(
			(f) => f.filter((frame) => frame.type === "reply").length >= 2,
		);
		// The allowance came back, so the message the quota refused goes through now.
		expect(
			socket.frames.filter((frame) => frame.type === "error"),
		).toHaveLength(1);
		const tool = seen[1]?.results.join("") ?? "";
		expect(tool).toContain("removed after its retention period");
		expect(tool).not.toContain(dataDir);
		const reader = seen[2]?.results.join("") ?? "";
		expect(reader).toContain("removed after its retention period");
		expect(reader).not.toContain(dataDir);
		socket.socket.close();
	});
});
