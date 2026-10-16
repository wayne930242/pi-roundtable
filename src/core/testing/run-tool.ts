import type {
	ExtensionAPI,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { ClientPart } from "../domain/client.ts";
import type { ReplyFile } from "../domain/conversation.ts";
import { PluginError } from "../errors.ts";
import {
	attachReplyFile,
	hasReplyFileScope,
	withReplyFiles,
} from "../reply-files.ts";

/** What a session registers of a tool: the call the model's tool call reaches. */
export interface RegisteredTool {
	name: string;
	execute(
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<{
		content: readonly {
			type: string;
			text?: string;
			data?: string;
			mimeType?: string;
		}[];
		isError?: boolean;
	}>;
}

/** What the model would get back from one tool call, and what the call attached beside the text. */
export interface ToolCallResult {
	text: string;
	files: ReplyFile[];
	images: ClientPart[];
}

/** Anything an extension may call or read on the Pi API besides registering a tool: accepted, does nothing. */
type Ignored = (...args: readonly never[]) => Ignored;

function ignored(): Ignored {
	return new Proxy((() => ignored()) as Ignored, {
		get: (target, key) => (key === "then" ? undefined : target),
	});
}

/** The tools a factory registers, in order; every other registration (handlers, commands, events) is accepted and ignored. */
export async function registeredTools(
	factory: ExtensionFactory | null | undefined,
): Promise<RegisteredTool[]> {
	const tools: RegisteredTool[] = [];
	if (!factory) return tools;
	// SAFETY: a session factory only registers tools, handlers and commands; the fake records the tools and ignores the rest.
	const api = new Proxy(
		{},
		{
			get: (_target, key) =>
				key === "registerTool"
					? (definition: RegisteredTool) => tools.push(definition)
					: ignored(),
		},
	) as unknown as ExtensionAPI;
	await factory(api);
	return tools;
}

/**
 * Runs the call as a turn on a surface that takes files or not runs it: the text, the files it
 * attached and the images it returned. A file is also queued for the enclosing real turn when a
 * fake runtime runs the call inside one. A tool that throws, or reports an error, throws here.
 */
export async function callRegisteredTool(
	tool: RegisteredTool,
	args: Record<string, unknown>,
	supportsFiles: boolean,
): Promise<ToolCallResult> {
	const images: ClientPart[] = [];
	const result = await withReplyFiles(supportsFiles, async () => {
		const output = await tool.execute("test-call", args);
		for (const item of output.content)
			if (item.type === "image" && item.data && item.mimeType)
				images.push({
					mimeType: item.mimeType,
					data: new Uint8Array(Buffer.from(item.data, "base64")),
				});
		return {
			ok: true,
			text: output.content
				.filter((item) => item.type === "text")
				.map((item) => item.text ?? "")
				.join("\n"),
		};
	});
	if (!result.ok) throw result.error;
	const files = result.files ?? [];
	// When a tool is run by a fake runtime, forward into the enclosing real turn.
	if (hasReplyFileScope()) for (const file of files) attachReplyFile(file);
	return { text: result.text, files, images };
}

/** The registered tool called `name`, or the PluginError a test reads. */
export function toolNamed(
	tools: readonly RegisteredTool[],
	name: string,
): RegisteredTool {
	const found = tools.find((tool) => tool.name === name);
	if (!found) throw new PluginError(`tool ${name} is not registered`);
	return found;
}
