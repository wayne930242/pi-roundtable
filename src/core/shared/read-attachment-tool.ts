import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { READ_LIMIT, readAttachment } from "./attachment-reader.ts";

/** Registers `read_attachment` over one channel's attachment store. */
export function readAttachmentExtension(dir: string): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: "read_attachment",
			label: "Read attachment",
			description:
				"Read a text or PDF file someone attached in this channel, by the file name listed under Attachments. Long files come in pieces; pass offset to continue.",
			parameters: Type.Object({
				file: Type.String({
					description: "File name from the Attachments list.",
				}),
				offset: Type.Optional(
					Type.Integer({
						minimum: 0,
						description: "Character offset to start from.",
					}),
				),
			}),
			execute: async (_toolCallId, params) => {
				const { text, total } = await readAttachment(
					dir,
					params.file,
					params.offset ?? 0,
				);
				const start = params.offset ?? 0;
				const end = start + text.length;
				const more =
					end < total
						? `\n\n[${end} of ${total} characters shown; call again with offset ${end} for more]`
						: "";
				return {
					content: [{ type: "text", text: `${text}${more}` }],
					details: { total, limit: READ_LIMIT },
				};
			},
		});
	};
}
