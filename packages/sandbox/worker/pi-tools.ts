import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readdirSync,
	readSync,
	writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
	type ReplyFile,
	type SessionContext,
	type ToolContribution,
	withReplyFiles,
} from "pi-roundtable";
import { toolText } from "pi-roundtable/kit";
import type { TSchema } from "typebox";
import {
	PI_MEDIA_LIMITS,
	type PiToolResponse,
	type PiTurnContext,
	safeFileName,
	validateImages,
} from "../src/pi-protocol.ts";
import { boundedText } from "../src/protocol.ts";

export interface PiWorkerToolSpec {
	name: string;
	label: string;
	description: string;
	parameters: TSchema;
}
export function saveToOutbox(
	turn: PiTurnContext,
	stem: string,
	data: Uint8Array,
	ext = "png",
): string {
	if (
		!safeFileName(stem) ||
		!/^[a-z0-9]{1,10}$/.test(ext) ||
		data.byteLength > PI_MEDIA_LIMITS.fileBytes ||
		data.byteLength === 0
	)
		throw new Error("Invalid output file");
	let name = `${stem}.${ext}`;
	for (let n = 2; readdirSync(turn.outbox).includes(name); n++)
		name = `${stem}-${n}.${ext}`;
	writeFileSync(join(turn.outbox, name), data, { flag: "wx" });
	return name;
}
export function boundedFile(path: string, limit: number): Uint8Array {
	const fd = openSync(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const info = fstatSync(fd);
		if (!info.isFile() || info.size < 1 || info.size > limit)
			throw new Error("Invalid or oversized file");
		const data = Buffer.alloc(info.size + 1);
		let count = 0;
		while (count < data.length) {
			const size = readSync(fd, data, count, data.length - count, null);
			if (!size) break;
			count += size;
		}
		if (count !== info.size) throw new Error("File changed while reading");
		return data.subarray(0, count);
	} finally {
		closeSync(fd);
	}
}
const IMAGE_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};
export function brokerToolsExtension(
	socket: string,
	attachments: string,
	turn: () => PiTurnContext,
	specs: readonly PiWorkerToolSpec[],
): ExtensionFactory {
	return (pi) => {
		for (const spec of specs)
			pi.registerTool({
				...spec,
				execute: async (_id, params, signal) => {
					const input = { ...(params as Record<string, unknown>) };
					if (
						spec.name === "image_generate" &&
						Array.isArray(input.reference_images)
					) {
						if (input.reference_images.length > 4)
							throw new Error("At most four references");
						input.reference_images = input.reference_images.map(
							(name: unknown) => {
								if (
									typeof name !== "string" ||
									!safeFileName(name) ||
									basename(name) !== name
								)
									throw new Error("Invalid attachment name");
								const mimeType = IMAGE_TYPES[extname(name).toLowerCase()];
								if (!mimeType) throw new Error("Not an image attachment");
								return {
									data: Buffer.from(
										boundedFile(
											join(attachments, name),
											PI_MEDIA_LIMITS.imageBytes,
										),
									).toString("base64"),
									mimeType,
								};
							},
						);
						validateImages(input.reference_images);
					}
					const response = await fetch(`http://broker/tools/${spec.name}`, {
						unix: socket,
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ input }),
						...(signal ? { signal } : {}),
					});
					if (!response.ok)
						throw new Error(`Broker answered ${response.status}`);
					const body = JSON.parse(
						await boundedText(response.body, 32 * 1024 * 1024),
					) as PiToolResponse;
					if (!body.ok) throw new Error(body.error ?? "Host tool failed");
					if (body.image) {
						validateImages([body.image]);
						saveToOutbox(
							turn(),
							"image",
							Buffer.from(body.image.data, "base64"),
						);
					}
					return toolText(body.text ?? "");
				},
			});
	};
}

/** Use public core Tool contributions inside Pi without copying their implementations. */
export function contributionExtension(
	contributions: readonly ToolContribution[],
	context: SessionContext,
	turn: () => PiTurnContext,
	adapt?: (
		name: string,
		input: Record<string, unknown>,
	) => Record<string, unknown>,
): ExtensionFactory {
	return (pi) => {
		for (const contribution of contributions) {
			const factory = contribution.session.snapshot().factory(context);
			if (!factory) continue;
			const proxy = new Proxy(pi, {
				get(target, prop, receiver) {
					if (prop !== "registerTool")
						return Reflect.get(target, prop, receiver);
					return (tool: Parameters<typeof pi.registerTool>[0]) => {
						pi.registerTool({
							...tool,
							execute: async (id, params, signal, update, ctx, ...rest) => {
								let toolResult:
									| Awaited<ReturnType<typeof tool.execute>>
									| undefined;
								const result = await withReplyFiles(true, async () => {
									toolResult = await tool.execute(
										id,
										adapt
											? adapt(tool.name, params as Record<string, unknown>)
											: params,
										signal,
										update,
										ctx,
										...rest,
									);
									return { ok: true, text: "" };
								});
								if (result.ok)
									for (const file of result.files ?? [])
										writeReplyFile(turn(), file);
								if (!toolResult)
									throw new Error("Contribution produced no tool result");
								return toolResult;
							},
						});
					};
				},
			});
			void factory(proxy);
		}
	};
}
function writeReplyFile(turn: PiTurnContext, file: ReplyFile): void {
	if (!safeFileName(file.name)) throw new Error("Invalid reply filename");
	const ext = extname(file.name).slice(1) || "bin";
	const stem = extname(file.name)
		? file.name.slice(0, -(ext.length + 1))
		: file.name;
	saveToOutbox(turn, stem, file.data, ext);
}
