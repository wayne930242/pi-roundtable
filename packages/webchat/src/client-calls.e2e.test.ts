import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFauxCore,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	definePlugin,
	defineRoundtable,
	defineTool,
	Roundtable,
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
/** A real 1x1 image: the core checks the pictures a tool returns. */
const PNG = Uint8Array.from(
	Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
		"base64",
	),
);

/** What the peek tool's call to the client came to, as the tool saw it. */
type Outcome =
	| { ok: true; value: unknown; parts: number }
	| { ok: false; error: string };

let idp: TestIssuer;
let roundtable: Roundtable | undefined;
let port = 0;
let dataDir = "";
let faux: ReturnType<typeof createFauxCore>;
const outcomes: Outcome[] = [];
/** The content of each tool result the model was given. */
const results: unknown[] = [];

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

/**
 * The faux model: a message "peek <function> [<timeout ms>] [image]" makes it call the peek tool
 * with that function; once the tool answered, it says so.
 */
const script: FauxResponseFactory = (context) => {
	const last = context.messages.at(-1);
	if (last?.role === "toolResult") {
		results.push(last.content);
		return fauxAssistantMessage([fauxText("peeked")]);
	}
	const text =
		last?.role === "user"
			? typeof last.content === "string"
				? last.content
				: last.content
						.map((part) => ("text" in part ? part.text : ""))
						.join(" ")
			: "";
	const match = /peek (\w+)(?: (\d+))?/.exec(text);
	return fauxAssistantMessage(
		[
			fauxToolCall(
				/held peek/.test(text) ? "client_held_peek" : "client_peek",
				{
					name: match?.[1] ?? "page_status",
					...(match?.[2] ? { timeoutMs: Number(match[2]) } : {}),
				},
			),
		],
		{ stopReason: "toolUse" },
	);
};

async function fauxModel(dir: string): Promise<ModelRuntime> {
	faux = createFauxCore({ provider: "faux", models: [{ id: "faux-1" }] });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerProvider("faux", {
		api: faux.api,
		apiKey: "test",
		baseUrl: "http://faux.invalid",
		streamSimple: faux.streamSimple,
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

/** A tool that asks the turn's client to run a function, and the compaction tool the host requires. */
/** What the held tool saw of its approval, and what its client call came to. */
const approvals: { approvedPrompt: string | undefined }[] = [];

const peek = definePlugin({
	name: "peek",
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
				name: "client_held_peek",
				description:
					"Ask the client to run one of its functions, once the person approves.",
				parameters: Type.Object({
					name: Type.String(),
					timeoutMs: Type.Optional(Type.Number()),
				}),
				minTier: "member",
				hold: ({ name }) => `ask the page to run ${name}`,
				run: async ({ name }, turn) => {
					approvals.push({ approvedPrompt: turn.approvedPrompt });
					if (!turn.client) return "no client";
					const result = await turn.client.call(
						name,
						{ x: 1 },
						turn.approvedPrompt
							? { approval: { prompt: turn.approvedPrompt } }
							: undefined,
					);
					outcomes.push(
						result.ok
							? { ok: true, value: result.value, parts: result.parts.length }
							: { ok: false, error: result.error },
					);
					return result.ok ? "ran" : `failed: ${result.error}`;
				},
			}),
			defineTool({
				name: "client_peek",
				description: "Ask the client to run one of its functions.",
				parameters: Type.Object({
					name: Type.String(),
					timeoutMs: Type.Optional(Type.Number()),
				}),
				minTier: "member",
				run: async ({ name, timeoutMs }, turn) => {
					if (!turn.client) {
						outcomes.push({ ok: false, error: "no_client" });
						return "no client";
					}
					const result = await turn.client.call(
						name,
						{ x: 1 },
						timeoutMs ? { timeoutMs } : undefined,
					);
					outcomes.push(
						result.ok
							? { ok: true, value: result.value, parts: result.parts.length }
							: { ok: false, error: result.error },
					);
					return result.ok
						? { text: JSON.stringify(result.value), images: result.parts }
						: `failed: ${result.error}`;
				},
			}),
		],
	}),
});

describeDb(
	"a web chat whose clients run functions for the assistant's tools",
	() => {
		beforeAll(async () => {
			idp = await testIssuer();
			dataDir = mkdtempSync(join(tmpdir(), "webchat-client-e2e-"));
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
						peek,
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
									prompt: () => "You look at the page.",
									selection: {
										tools: ["client_peek", "client_held_peek"],
										groups: [],
									},
								},
							],
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

		/** A client's socket: a ticket from the API, spent in the subprotocol; it declares `tools` when it names any. */
		async function client(token: string, tools?: string[]) {
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
			const until = async <T>(
				find: (frames: ServerFrame[]) => T | undefined,
			) => {
				for (let waited = 0; waited <= 5000; waited += 10) {
					const found = find(frames);
					if (found !== undefined) return found;
					await Bun.sleep(10);
				}
				throw new Error(`timed out: ${JSON.stringify(frames)}`);
			};
			const send = (frame: object) => socket.send(JSON.stringify(frame));
			await until((f) => f.find((frame) => frame.type === "ready"));
			if (tools) send({ type: "client_hello", version: 1, tools });
			return {
				socket,
				frames,
				until,
				send,
				call: () =>
					until((f) => {
						const found = f.find((frame) => frame.type === "client_call");
						return found?.type === "client_call" ? found : undefined;
					}),
				frame: <K extends ServerFrame["type"]>(type: K) =>
					until((f) => {
						const found = f.find((frame) => frame.type === type);
						return found as Extract<ServerFrame, { type: K }> | undefined;
					}),
			};
		}

		const person = async (name: string) => ({
			token: await idp.sign({
				claims: { sub: `${name}-${crypto.randomUUID()}`, name },
			}),
		});

		const outcome = async (count = 1) => {
			for (let waited = 0; outcomes.length < count; waited += 10) {
				if (waited > 5000)
					throw new Error(`no outcome: ${JSON.stringify(outcomes)}`);
				await Bun.sleep(10);
			}
			return outcomes.at(-1);
		};
		const reset = () => {
			outcomes.length = 0;
			results.length = 0;
			approvals.length = 0;
			faux.setResponses([script, script]);
		};

		test("ready tells the client what a call may take", async () => {
			const { token } = await person("Ada");
			const ada = await client(token);
			expect(ada.frames[0]).toMatchObject({
				type: "ready",
				clientCalls: {
					timeoutMs: 30_000,
					maxTimeoutMs: 60_000,
					maxValueBytes: 48 * 1024,
					maxParts: 2,
					maxPartBytes: 2 * 1024 * 1024,
				},
			});
			ada.socket.close();
		});

		test("a tool's call reaches the client that sent the message, and its answer comes back as the tool's result", async () => {
			reset();
			const { token } = await person("Ada");
			const ada = await client(token, ["page_status"]);
			ada.send({
				type: "send",
				id: "m1",
				persona: "helpdesk",
				text: "peek page_status",
			});
			const call = await ada.call();
			expect(call).toMatchObject({
				name: "page_status",
				args: { x: 1 },
				timeoutMs: 30_000,
			});
			const accepted = await ada.frame("accepted");
			expect(call.conversation).toBe(accepted.conversation);
			ada.send({
				type: "client_result",
				call: call.call,
				ok: true,
				value: { url: "https://app.example/page" },
			});
			expect((await ada.frame("reply")).text).toBe("peeked");
			expect(await outcome()).toEqual({
				ok: true,
				value: { url: "https://app.example/page" },
				parts: 0,
			});
			expect(JSON.stringify(results[0])).toContain("https://app.example/page");
			ada.socket.close();
		});

		test("a call that acts on no approval carries none", async () => {
			reset();
			const { token } = await person("Ada");
			const ada = await client(token, ["page_status"]);
			ada.send({
				type: "send",
				id: "m1",
				persona: "helpdesk",
				text: "peek page_status",
			});
			const call = await ada.call();
			expect("approval" in call).toBe(false);
			ada.send({ type: "client_result", call: call.call, ok: true, value: 1 });
			await ada.frame("reply");
			ada.socket.close();
		});

		test("a held tool approved on its card sees that card's id, and its client call carries it as the approval", async () => {
			reset();
			const { token } = await person("Ada");
			const ada = await client(token, ["page_status"]);
			ada.send({
				type: "send",
				id: "m1",
				persona: "helpdesk",
				text: "held peek page_status",
			});
			const prompt = await ada.frame("prompt");
			expect(prompt.prompt.kind).toBe("approval");
			// Nothing was asked of the client before the person approved.
			expect(ada.frames.some((frame) => frame.type === "client_call")).toBe(
				false,
			);
			ada.send({ type: "approval", prompt: prompt.prompt.id, approved: true });
			const call = await ada.call();
			expect(call.approval).toEqual({ prompt: prompt.prompt.id });
			expect(approvals).toEqual([{ approvedPrompt: prompt.prompt.id }]);
			ada.send({ type: "client_result", call: call.call, ok: true, value: 1 });
			expect((await ada.frame("reply")).text).toBe("peeked");
			ada.socket.close();
		});

		test("a held tool the person declines never runs, so no approval reaches the client", async () => {
			reset();
			const { token } = await person("Ada");
			const ada = await client(token, ["page_status"]);
			ada.send({
				type: "send",
				id: "m1",
				persona: "helpdesk",
				text: "held peek page_status",
			});
			const prompt = await ada.frame("prompt");
			ada.send({ type: "approval", prompt: prompt.prompt.id, approved: false });
			await ada.frame("reply");
			expect(approvals).toEqual([]);
			expect(ada.frames.some((frame) => frame.type === "client_call")).toBe(
				false,
			);
			ada.socket.close();
		});

		test("a screenshot goes over REST first, and the answer names it; the model is given the image", async () => {
			reset();
			const { token } = await person("Ada");
			const ada = await client(token, ["page_shot"]);
			ada.send({
				type: "send",
				id: "m1",
				persona: "helpdesk",
				text: "peek page_shot",
			});
			const call = await ada.call();
			const path = `conversations/${call.conversation}/client-calls/${call.call}/parts`;
			const put = (
				n: number,
				body: string | Uint8Array,
				type: string,
				who = token,
			) =>
				api(`${path}/${n}`, {
					method: "PUT",
					token: who,
					headers: { "content-type": type },
					body,
				});
			expect((await put(0, PNG, "image/png")).status).toBe(201);
			expect((await put(0, PNG, "image/png")).status).toBe(409);
			expect((await put(1, "not an image", "image/png")).status).toBe(415);
			expect((await put(1, PNG, "application/json")).status).toBe(415);
			expect((await put(2, PNG, "image/png")).status).toBe(400);
			expect(
				(
					await put(
						1,
						new Uint8Array(2 * 1024 * 1024 + 1).fill(0xff),
						"image/jpeg",
					)
				).status,
			).toBe(413);
			// Someone else cannot add to it, with a token of their own.
			const eve = await person("Eve");
			expect((await put(1, PNG, "image/png", eve.token)).status).toBe(403);
			ada.send({
				type: "client_result",
				call: call.call,
				ok: true,
				value: { title: "Orders" },
				parts: 1,
			});
			expect((await ada.frame("reply")).text).toBe("peeked");
			expect(await outcome()).toEqual({
				ok: true,
				value: { title: "Orders" },
				parts: 1,
			});
			expect(JSON.stringify(results[0])).toContain(
				Buffer.from(PNG).toString("base64"),
			);
			// The call is over, so a late part finds nothing.
			expect((await put(1, PNG, "image/png")).status).toBe(404);
			ada.socket.close();
		});

		test("stopping the conversation cancels the call in flight and tells the client", async () => {
			reset();
			const { token } = await person("Ada");
			const ada = await client(token, ["page_status"]);
			ada.send({
				type: "send",
				id: "m1",
				persona: "helpdesk",
				text: "peek page_status",
			});
			const call = await ada.call();
			const { conversation } = await ada.frame("accepted");
			ada.send({ type: "stop", conversation });
			const cancel = await ada.frame("client_cancel");
			expect(cancel).toEqual({
				type: "client_cancel",
				call: call.call,
				reason: "turn_stopped",
			});
			expect(await outcome()).toEqual({ ok: false, error: "cancelled" });
			expect(await ada.frame("failed")).toMatchObject({ stopped: true });
			// The call is closed: a late answer is refused.
			ada.send({ type: "client_result", call: call.call, ok: true, value: 1 });
			expect(
				await ada.until((f) =>
					f.find(
						(frame) => frame.type === "error" && frame.code === "unknown_call",
					),
				),
			).toMatchObject({ ref: call.call });
			ada.socket.close();
		});

		test("a client that disconnects mid-call ends it as disconnected", async () => {
			reset();
			const { token } = await person("Ada");
			const ada = await client(token, ["page_status"]);
			ada.send({
				type: "send",
				id: "m1",
				persona: "helpdesk",
				text: "peek page_status",
			});
			await ada.call();
			ada.socket.close();
			expect(await outcome()).toEqual({ ok: false, error: "disconnected" });
		});

		test("a call the client does not answer times out, and the client is told to stop", async () => {
			reset();
			const { token } = await person("Ada");
			const ada = await client(token, ["page_status"]);
			ada.send({
				type: "send",
				id: "m1",
				persona: "helpdesk",
				text: "peek page_status 150",
			});
			const call = await ada.call();
			expect(call.timeoutMs).toBe(150);
			expect(await ada.frame("client_cancel")).toEqual({
				type: "client_cancel",
				call: call.call,
				reason: "timeout",
			});
			expect(await outcome()).toEqual({ ok: false, error: "timeout" });
			expect((await ada.frame("reply")).text).toBe("peeked");
			ada.socket.close();
		});

		test("another connection of the same person is never asked and cannot answer", async () => {
			reset();
			const { token } = await person("Ada");
			const first = await client(token, ["page_status"]);
			const second = await client(token, ["page_status"]);
			first.send({
				type: "send",
				id: "m1",
				persona: "helpdesk",
				text: "peek page_status",
			});
			const call = await first.call();
			second.send({
				type: "client_result",
				call: call.call,
				ok: true,
				value: { forged: true },
			});
			expect(
				await second.until((f) =>
					f.find(
						(frame) => frame.type === "error" && frame.code === "unknown_call",
					),
				),
			).toMatchObject({ ref: call.call });
			expect(second.frames.some((frame) => frame.type === "client_call")).toBe(
				false,
			);
			expect(outcomes).toEqual([]);
			first.send({
				type: "client_result",
				call: call.call,
				ok: true,
				value: "real",
			});
			expect(await outcome()).toEqual({ ok: true, value: "real", parts: 0 });
			first.socket.close();
			second.socket.close();
		});

		test("a connection that never declared functions runs its turns without a client", async () => {
			reset();
			const { token } = await person("Ada");
			const ada = await client(token);
			ada.send({
				type: "send",
				id: "m1",
				persona: "helpdesk",
				text: "peek page_status",
			});
			expect((await ada.frame("reply")).text).toBe("peeked");
			expect(await outcome()).toEqual({ ok: false, error: "no_client" });
			expect(ada.frames.some((frame) => frame.type === "client_call")).toBe(
				false,
			);
			ada.socket.close();
		});
	},
);
