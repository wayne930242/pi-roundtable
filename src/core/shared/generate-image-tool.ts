import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ImageDrawer, ReferenceImage } from "../contract/providers.ts";
import {
	attachReplyFile,
	REPLY_FILE_LIMITS,
	ReplyFileError,
} from "../reply-files.ts";
import { toolError, toolText } from "./tool-result.ts";
import {
	findWorkspaceFile,
	readWorkspaceFile,
	WorkspaceFileError,
	type WorkspaceRoots,
} from "./workspace-files.ts";

export const GENERATE_IMAGE_TOOL = "generate_image";

/** The limits on the reference images one call passes to the drawer. */
export const REFERENCE_IMAGE_LIMITS = Object.freeze({
	maxImages: 4,
	maxImageBytes: 20 * 1024 * 1024,
	maxTotalBytes: 40 * 1024 * 1024,
});

const MAX_PROMPT_CHARS = 4000;

/** The image type of `data` by its content, or undefined for anything else. */
export function imageTypeOf(
	data: Uint8Array,
): { mimeType: string; ext: string } | undefined {
	const starts = (bytes: readonly number[], at = 0) =>
		bytes.every((byte, i) => data[at + i] === byte);
	if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
		return { mimeType: "image/png", ext: "png" };
	if (starts([0xff, 0xd8, 0xff])) return { mimeType: "image/jpeg", ext: "jpg" };
	if (starts([0x47, 0x49, 0x46, 0x38]))
		return { mimeType: "image/gif", ext: "gif" };
	if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8))
		return { mimeType: "image/webp", ext: "webp" };
	return undefined;
}

async function readReferences(
	paths: readonly string[],
	roots: WorkspaceRoots,
): Promise<ReferenceImage[]> {
	const { maxImages, maxImageBytes, maxTotalBytes } = REFERENCE_IMAGE_LIMITS;
	if (paths.length > maxImages)
		throw new WorkspaceFileError(
			`${paths.length} reference images given; at most ${maxImages} are allowed.`,
		);
	const files = await Promise.all(
		paths.map((path) => findWorkspaceFile(path, roots)),
	);
	let total = 0;
	for (const file of files) {
		if (file.size > maxImageBytes)
			throw new WorkspaceFileError(
				`${file.path} is ${file.size} bytes; a reference image may contain at most ${maxImageBytes} bytes.`,
			);
		total += file.size;
	}
	if (total > maxTotalBytes)
		throw new WorkspaceFileError(
			`the reference images total ${total} bytes; at most ${maxTotalBytes} are allowed.`,
		);
	const references: ReferenceImage[] = [];
	for (const file of files) {
		const data = await readWorkspaceFile(file, maxImageBytes);
		const type = imageTypeOf(data);
		if (!type)
			throw new WorkspaceFileError(
				`${file.path} is not a PNG, JPEG, WebP or GIF image.`,
			);
		references.push({
			data: Buffer.from(data).toString("base64"),
			mimeType: type.mimeType,
		});
	}
	return references;
}

/**
 * Registers `generate_image`, which draws a new picture with the host's image provider, saves it
 * under `<scratch dir or workspace>/drawings`, and attaches it to the turn's reply.
 */
export function generateImageExtension(
	draw: ImageDrawer,
	roots: WorkspaceRoots,
): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: GENERATE_IMAGE_TOOL,
			label: "Generate image",
			description:
				'Generate a new picture from a description. Describe the subject, style and composition; say "no text" when you will add text to it later. The picture is saved to a file whose path the result names, and attached to your reply.',
			parameters: Type.Object(
				{
					prompt: Type.String({
						minLength: 1,
						maxLength: MAX_PROMPT_CHARS,
						description:
							"What to draw: subject, style, composition, and anything to leave out.",
					}),
					reference_paths: Type.Optional(
						Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
							maxItems: REFERENCE_IMAGE_LIMITS.maxImages,
							description:
								"Paths of PNG, JPEG, WebP or GIF images inside the workspace or the scratch dir to draw from.",
						}),
					),
				},
				{ additionalProperties: false },
			),
			execute: async (_toolCallId, params, signal) => {
				let references: ReferenceImage[];
				try {
					references = await readReferences(
						params.reference_paths ?? [],
						roots,
					);
				} catch (error) {
					if (error instanceof WorkspaceFileError)
						return toolError(`Not drawn: ${error.message}`);
					throw error;
				}
				signal?.throwIfAborted();
				let data: Uint8Array;
				try {
					data = await draw(
						params.prompt,
						references,
						signal ? { signal } : {},
					);
				} catch (error) {
					signal?.throwIfAborted();
					return toolError(
						`The image provider did not draw it: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				signal?.throwIfAborted();
				const type = imageTypeOf(data);
				if (!type)
					return toolError(
						"The image provider returned something that is not a PNG, JPEG, WebP or GIF image.",
					);
				const dir = join(roots.scratchDir ?? roots.workspace, "drawings");
				await mkdir(dir, { recursive: true });
				const name = `generated-${new Date().toISOString().replace(/[:.]/g, "-")}.${type.ext}`;
				const path = join(dir, name);
				await writeFile(path, data);
				try {
					if (data.byteLength > REPLY_FILE_LIMITS.maxFileBytes)
						throw new ReplyFileError(
							`it is ${data.byteLength} bytes; a reply file may contain at most ${REPLY_FILE_LIMITS.maxFileBytes} bytes.`,
						);
					attachReplyFile({ name, data });
				} catch (error) {
					if (!(error instanceof ReplyFileError)) throw error;
					return toolText(
						`Drew the picture and saved it to ${path} (${data.byteLength} bytes), but it is not attached: ${error.message}`,
					);
				}
				return toolText(
					`Drew the picture, saved it to ${path} (${data.byteLength} bytes); it will appear with your reply.`,
				);
			},
		});
	};
}
