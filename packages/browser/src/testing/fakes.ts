import type {
	ChannelKey,
	ChatSurface,
	OutboundReply,
	WorkerSessionRequest,
	WorkerSessions,
} from "pi-roundtable";
import { Type } from "typebox";
import {
	type BrowserDriver,
	type BrowserTaskContext,
	type BrowserTaskKit,
	browserTool,
} from "../driver.ts";

/** A credential-shaped string, built so the public scan finds none in the tree. */
export const LEAKED_SECRET = [
	"sk",
	"abcdefghijklmnopqrstuvwxyz0123456789",
].join("-");
const LEAKED_HEADER = ["Bearer", LEAKED_SECRET].join(" ");

/** What a Pi session sees of a registered tool, and what the fake worker calls. */
interface FakeTool {
	name: string;
	description: string;
	execute(
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<{
		content: {
			type: string;
			text?: string;
			data?: string;
			mimeType?: string;
		}[];
		isError?: boolean;
	}>;
}

export interface Worker {
	request: WorkerSessionRequest;
	/** Calls one of the worker's tools as the model would. */
	call(
		name: string,
		params?: Record<string, unknown>,
	): Promise<{ text: string; isError: boolean; images: number }>;
	/** The names of the tools the extensions registered. */
	registered: string[];
}

/**
 * Worker sessions whose "model" is a script: it gets the tools the request's extensions register,
 * calls them, and returns the report.
 */
export function scriptedSessions(
	script: (worker: Worker) => Promise<string>,
): WorkerSessions & { requests: WorkerSessionRequest[] } {
	const requests: WorkerSessionRequest[] = [];
	return {
		requests,
		delegation: { model: "fake/host-model", thinking: "low" },
		async run(request) {
			requests.push(request);
			const tools = new Map<string, FakeTool>();
			const api = {
				registerTool: (tool: FakeTool) => tools.set(tool.name, tool),
			};
			// SAFETY: the browser extension only registers tools.
			for (const extension of request.extensions)
				await (extension as (pi: unknown) => Promise<void>)(api);
			return script({
				request,
				registered: [...tools.keys()],
				call: async (name, params = {}) => {
					const tool = tools.get(name);
					if (!tool || !request.toolNames.includes(name))
						return { text: `Tool ${name} not found`, isError: true, images: 0 };
					const result = await tool.execute("call", params, request.signal);
					return {
						text: result.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n"),
						isError: result.isError === true,
						images: result.content.filter((part) => part.type === "image")
							.length,
					};
				},
			});
		},
	};
}

/** A PNG header with the given total size, enough to pass for a screenshot. */
function fakePng(size = 64): Uint8Array {
	const bytes = new Uint8Array(size);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	return bytes;
}

export interface FakeDriver extends BrowserDriver {
	started: number;
	disposed: number;
	contexts: BrowserTaskContext[];
}

/** A driver with a `browser_look` tool that answers text, and a `browser_shot` tool that keeps a screenshot. */
export function fakeDriver(
	options: {
		check?: () => Promise<void>;
		screenshotBytes?: number;
		disposeFails?: boolean;
	} = {},
): FakeDriver {
	const driver: FakeDriver = {
		started: 0,
		disposed: 0,
		contexts: [],
		...(options.check ? { check: options.check } : {}),
		async start(context): Promise<BrowserTaskKit> {
			driver.started++;
			driver.contexts.push(context);
			return {
				prompt: "FAKE-DRIVER-PROMPT: use browser_look and browser_shot.",
				skills: [{ name: "fake skill", content: "FAKE-SKILL-BODY" }],
				tools: [
					browserTool({
						name: "browser_look",
						description: "Look at the page.",
						parameters: Type.Object({ what: Type.Optional(Type.String()) }),
						execute: async ({ what }) => ({
							text: `page says ${what ?? "hello"}`,
						}),
					}),
					browserTool({
						name: "browser_boom",
						description: "Fails with a message that carries a secret.",
						parameters: Type.Object({}),
						execute: async () => {
							throw new Error(
								`upstream said no: Authorization: ${LEAKED_HEADER}`,
							);
						},
					}),
					browserTool({
						name: "browser_shot",
						description: "Screenshot the page.",
						parameters: Type.Object({}),
						execute: async () => {
							const data = fakePng(options.screenshotBytes ?? 64);
							const kept = context.keepScreenshot({
								mimeType: "image/png",
								data,
							});
							return {
								text: `kept ${kept}`,
								images: [{ mimeType: "image/png", data }],
							};
						},
					}),
				],
				dispose: async () => {
					driver.disposed++;
					if (options.disposeFails) throw new Error("cleanup broke");
				},
			};
		},
	};
	return driver;
}

/** A chat surface for the prefix `test` that takes files. */
export class FilesSurface implements ChatSurface {
	readonly surface = "test";
	readonly supportsFiles = true;
	readonly replies: { channel: ChannelKey; reply: OutboundReply }[] = [];
	async start(): Promise<void> {}
	async sendReply(channel: ChannelKey, reply: OutboundReply): Promise<void> {
		this.replies.push({ channel, reply });
	}
}
