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
	CONVERSATIONS,
	definePlugin,
	defineRoundtable,
	defineTool,
	type PluginContext,
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
/** A 1x1 PNG. */
const PNG = Uint8Array.from(
	atob(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	),
	(char) => char.charCodeAt(0),
);
const RECORDING = '{"events":[1,2,3]}';
const text = (value: string) => new TextEncoder().encode(value);

let idp: TestIssuer;
let roundtable: Roundtable | undefined;
let context: PluginContext | undefined;
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
						const bytes = await attachment.bytes();
						return `${attachment.name}|${attachment.contentType}|${attachment.size}|${new TextDecoder().decode(bytes)}`;
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

describeDb("web chat attachments over a real host", () => {
	beforeAll(async () => {
		idp = await testIssuer();
		dataDir = mkdtempSync(join(tmpdir(), "webchat-att-"));
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
							attachmentsPerMessage: 3,
							uploadsPerHour: 8,
							unsentUploadBytesPerPrincipal: 20_000,
							unsentUploadTtlMs: 400,
						},
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

	/** A person: their token and an opened conversation. */
	async function person(name: string) {
		const token = await idp.sign({
			claims: { sub: `${name}-${crypto.randomUUID()}`, name },
		});
		const open = async () => {
			const response = await api("conversations", {
				method: "POST",
				token,
				body: JSON.stringify({ persona: "helpdesk" }),
			});
			expect(response.status).toBe(201);
			return ((await response.json()) as { conversation: string }).conversation;
		};
		return { token, open };
	}

	const upload = (
		token: string | undefined,
		conversation: string,
		body: Uint8Array,
		type: string | undefined,
		name = "file",
	) =>
		api(
			`conversations/${conversation}/files?name=${encodeURIComponent(name)}`,
			{
				method: "POST",
				...(token ? { token } : {}),
				headers: type ? { "content-type": type } : {},
				body,
			},
		);

	const uploaded = async (response: Response) => {
		expect(response.status).toBe(201);
		return (await response.json()) as {
			file: string;
			name: string;
			contentType: string;
			size: number;
		};
	};

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

	test("an uploaded screenshot and recording reach the turn: the model sees the image and the listing, and read_attachment reads the JSON", async () => {
		const ada = await person("Ada");
		const conversation = await ada.open();
		const shot = await uploaded(
			await upload(ada.token, conversation, PNG, "image/png", "screenshot.png"),
		);
		const recording = await uploaded(
			await upload(
				ada.token,
				conversation,
				text(RECORDING),
				"application/json; charset=utf-8",
				"session.json",
			),
		);
		expect(shot).toMatchObject({
			name: "screenshot.png",
			contentType: "image/png",
			size: PNG.byteLength,
		});
		expect(recording.contentType).toBe("application/json");
		seen.length = 0;
		script.setResponses([
			step({ tool: "read_attachment", args: { file: recording.file } }),
			step(),
		]);
		const socket = await browser(ada.token);
		socket.send({
			type: "send",
			id: "m1",
			conversation,
			text: "What went wrong?",
			attachments: [shot.file, recording.file],
		});
		await socket.until((f) => f.some((frame) => frame.type === "reply"));
		const first = JSON.stringify(seen[0]?.user);
		expect(first).toContain("## Attachments");
		expect(first).toContain(shot.file);
		expect(first).toContain(recording.file);
		expect(first).toContain('"type":"image"');
		expect(first).toContain("What went wrong?");
		// The second request carries the JSON that read_attachment returned.
		expect(seen[1]?.results.join("")).toContain(RECORDING);
		// The files now belong to the conversation: the upload cannot be used again.
		socket.send({
			type: "send",
			id: "m2",
			conversation,
			text: "again",
			attachments: [shot.file],
		});
		await socket.until((f) => f.some((frame) => frame.type === "error"));
		expect(socket.frames.find((frame) => frame.type === "error")).toEqual({
			type: "error",
			code: "unknown_attachment",
			ref: "m2",
		});
		socket.socket.close();
	});

	test("a tool reads the same bytes with turn.attachment(), and a path is refused", async () => {
		const ada = await person("Ada");
		const conversation = await ada.open();
		const recording = await uploaded(
			await upload(
				ada.token,
				conversation,
				text(RECORDING),
				"application/json",
				"session.json",
			),
		);
		seen.length = 0;
		script.setResponses([
			step({ tool: "file_probe", args: { file: recording.file } }),
			step({ tool: "file_probe", args: { file: "../session.json" } }),
			step(),
		]);
		const socket = await browser(ada.token);
		socket.send({
			type: "send",
			id: "m1",
			conversation,
			text: "Pass it on",
			attachments: [recording.file],
		});
		await socket.until((f) => f.some((frame) => frame.type === "reply"));
		expect(seen[1]?.results.join("")).toContain(
			`session.json|application/json|${RECORDING.length}|${RECORDING}`,
		);
		expect(seen[2]?.results.join("")).toContain("not an attachment name");
		socket.socket.close();
	});

	test("the REST upload answers 401 without a token, 403 for another person's conversation, 404 for an unknown one", async () => {
		const ada = await person("Ada");
		const bob = await person("Bob");
		const conversation = await ada.open();
		expect(
			(await upload(undefined, conversation, text("x"), "text/plain")).status,
		).toBe(401);
		const forbidden = await upload(
			bob.token,
			conversation,
			text("x"),
			"text/plain",
		);
		expect(forbidden.status).toBe(403);
		expect(await forbidden.json()).toEqual({ error: "forbidden" });
		expect(
			(await upload(ada.token, "no-such-conversation", text("x"), "text/plain"))
				.status,
		).toBe(404);
		// Nothing of Bob's refused upload is waiting for Ada or for him.
		expect(await ada.open()).not.toBe(conversation);
	});

	test("the REST upload refuses a file over the limit with 413, a type that is not accepted or bytes that do not match with 415, and a missing name with 400", async () => {
		const ada = await person("Ada");
		const conversation = await ada.open();
		const big = await upload(
			ada.token,
			conversation,
			new Uint8Array(2049).fill(97),
			"text/plain",
		);
		expect(big.status).toBe(413);
		expect(await big.json()).toEqual({ error: "payload_too_large" });
		const exact = await upload(
			ada.token,
			conversation,
			new Uint8Array(2048).fill(97),
			"text/plain",
		);
		expect(exact.status).toBe(201);
		expect(
			(await upload(ada.token, conversation, text("<html/>"), "text/html"))
				.status,
		).toBe(415);
		expect(
			(await upload(ada.token, conversation, text("x"), undefined)).status,
		).toBe(415);
		const lie = await upload(
			ada.token,
			conversation,
			text("not an image"),
			"image/png",
			"shot.png",
		);
		expect(lie.status).toBe(415);
		expect(await lie.json()).toEqual({ error: "unsupported_media_type" });
		const unnamed = await api(`conversations/${conversation}/files`, {
			method: "POST",
			token: ada.token,
			headers: { "content-type": "text/plain" },
			body: text("x"),
		});
		expect(unnamed.status).toBe(400);
	});

	test("the REST upload answers 429 once the person made their uploads for the hour, and only theirs", async () => {
		const ada = await person("Ada");
		const bob = await person("Bob");
		const conversation = await ada.open();
		for (let i = 0; i < 8; i += 1)
			expect(
				(
					await upload(
						ada.token,
						conversation,
						text("x"),
						"text/plain",
						`${i}.txt`,
					)
				).status,
			).toBe(201);
		const limited = await upload(
			ada.token,
			conversation,
			text("x"),
			"text/plain",
		);
		expect(limited.status).toBe(429);
		expect(await limited.json()).toEqual({ error: "too_many_uploads" });
		expect(
			(await upload(bob.token, await bob.open(), text("x"), "text/plain"))
				.status,
		).toBe(201);
	});

	test("a message cannot use a file uploaded to another conversation, another person's upload, or one nobody uploaded", async () => {
		const ada = await person("Ada");
		const bob = await person("Bob");
		const first = await ada.open();
		const second = await ada.open();
		const bobs = await bob.open();
		const inFirst = await uploaded(
			await upload(ada.token, first, text("x"), "text/plain", "a.txt"),
		);
		const inBobs = await uploaded(
			await upload(bob.token, bobs, text("x"), "text/plain", "b.txt"),
		);
		const socket = await browser(ada.token);
		const refusals: string[] = [];
		for (const [conversation, file] of [
			[second, inFirst.file],
			[second, inBobs.file],
			[first, "never-uploaded.txt"],
			[first, `${crypto.randomUUID()}-a.txt`],
		] as const) {
			// One at a time: a message in flight holds one of the person's places.
			const id = `m${refusals.length + 1}`;
			socket.send({
				type: "send",
				id,
				conversation,
				text: "x",
				attachments: [file],
			});
			await socket.until((f) =>
				f.some((frame) => frame.type === "error" && frame.ref === id),
			);
			const refused = socket.frames.find(
				(frame) => frame.type === "error" && frame.ref === id,
			);
			refusals.push(refused?.type === "error" ? refused.code : "none");
		}
		expect(refusals).toEqual(Array(4).fill("unknown_attachment"));
		expect(socket.frames.some((frame) => frame.type === "accepted")).toBe(
			false,
		);
		socket.socket.close();
	});

	test("a shared conversation takes no upload from the web chat, though the core would keep it", async () => {
		const ada = await person("Ada");
		const key: `web:${string}` = `web:${crypto.randomUUID()}`;
		await context?.services.get(CONVERSATIONS).register({
			key,
			kind: "helpdesk",
			visibility: "shared",
		});
		const response = await upload(
			ada.token,
			key.slice(4),
			text("x"),
			"text/plain",
		);
		expect(response.status).toBe(403);
	});

	test("ready tells the client the limits", async () => {
		const ada = await person("Ada");
		const socket = await browser(ada.token);
		expect(socket.frames[0]).toMatchObject({
			type: "ready",
			attachments: {
				maxBytes: 2048,
				perMessage: 3,
				types: [
					"image/png",
					"image/jpeg",
					"image/webp",
					"image/gif",
					"application/json",
					"text/plain",
					"application/pdf",
				],
			},
		});
		// A message with more files than the limit is refused as a bad frame.
		const conversation = await ada.open();
		socket.send({
			type: "send",
			id: "m1",
			conversation,
			text: "x",
			attachments: ["a", "b", "c", "d"],
		});
		await socket.until((f) => f.some((frame) => frame.type === "error"));
		expect(socket.frames.find((frame) => frame.type === "error")).toEqual({
			type: "error",
			code: "bad_frame",
			ref: "m1",
		});
		socket.socket.close();
	});

	test("an upload no message used is deleted once it is older than the limit's time", async () => {
		const ada = await person("Ada");
		const conversation = await ada.open();
		const kept = await uploaded(
			await upload(
				ada.token,
				conversation,
				text("x"),
				"text/plain",
				"late.txt",
			),
		);
		const waiting = () => {
			try {
				return readdirSync(join(dataDir, "attachments-pending"), {
					recursive: true,
				}).filter((entry) => String(entry).endsWith(kept.file));
			} catch {
				return [];
			}
		};
		expect(waiting()).toHaveLength(1);
		for (let waited = 0; waiting().length > 0; waited += 50) {
			if (waited > 5000) throw new Error("the upload was not deleted");
			await Bun.sleep(50);
		}
		const socket = await browser(ada.token);
		socket.send({
			type: "send",
			id: "m1",
			conversation,
			text: "too late",
			attachments: [kept.file],
		});
		await socket.until((f) => f.some((frame) => frame.type === "error"));
		expect(socket.frames.find((frame) => frame.type === "error")).toMatchObject(
			{
				code: "unknown_attachment",
			},
		);
		socket.socket.close();
	});
});
