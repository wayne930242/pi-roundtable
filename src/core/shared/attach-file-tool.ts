import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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

export const ATTACH_FILE_TOOL = "attach_file";

/** Registers `attach_file`, which posts a file from the session's disk with the turn's reply. */
export function attachFileExtension(roots: WorkspaceRoots): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: ATTACH_FILE_TOOL,
			label: "Attach file",
			description:
				"Show a file you have on disk, such as a picture you made, by attaching it to your reply in this conversation. Give its path inside the workspace or the scratch dir; never read an image or base64 a file to show it.",
			parameters: Type.Object(
				{
					path: Type.String({
						minLength: 1,
						maxLength: 4096,
						description:
							"The file's path inside the workspace or the scratch dir.",
					}),
					filename: Type.Optional(
						Type.String({
							minLength: 1,
							maxLength: 255,
							description:
								"The name it is posted under, without a path; defaults to the path's base name.",
						}),
					),
				},
				{ additionalProperties: false },
			),
			execute: async (_toolCallId, params) => {
				try {
					const file = await findWorkspaceFile(params.path, roots);
					if (file.size > REPLY_FILE_LIMITS.maxFileBytes)
						throw new ReplyFileError(
							`${params.path} is ${file.size} bytes; a reply file may contain at most ${REPLY_FILE_LIMITS.maxFileBytes} bytes.`,
						);
					const data = await readWorkspaceFile(
						file,
						REPLY_FILE_LIMITS.maxFileBytes,
					);
					const name = params.filename ?? file.name;
					attachReplyFile({ name, data });
					return toolText(
						`${name} (${data.byteLength} bytes) will appear with your reply.`,
					);
				} catch (error) {
					if (
						error instanceof WorkspaceFileError ||
						error instanceof ReplyFileError
					)
						return toolError(`Not attached: ${error.message}`);
					throw error;
				}
			},
		});
	};
}
