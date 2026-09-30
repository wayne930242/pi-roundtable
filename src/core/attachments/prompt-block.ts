import type { TurnAttachments } from "../domain/attachment.ts";

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Appends an `## Attachments` block naming every file the turn carries, so the model knows
 * what it can read or hand to tools. Files are named by their store file name, which is what
 * `read_attachment` and file-taking tools accept.
 */
export function withAttachmentsBlock(
	text: string,
	attachments: TurnAttachments,
): string {
	const lines: string[] = [];
	for (const file of attachments.files) {
		const origin = file.fromReference ? ", from the replied-to message" : "";
		lines.push(
			`- ${file.file} (original name "${file.name}", ${file.contentType}, ${formatSize(file.size)}${origin})`,
		);
	}
	for (const failure of attachments.failures) {
		const origin = failure.fromReference ? " from the replied-to message" : "";
		lines.push(
			`- "${failure.name}"${origin} could not be received: ${failure.reason}`,
		);
	}
	if (lines.length === 0) return text;
	const note =
		attachments.images.length > 0
			? "Images among them are shown to you directly. Read other files with read_attachment."
			: "Read them with read_attachment.";
	return `${text}\n\n## Attachments\n${note}\n${lines.join("\n")}`;
}
