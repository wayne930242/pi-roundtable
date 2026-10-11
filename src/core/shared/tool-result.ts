/** The text a tool returns, in the shape Pi expects. */
export function toolText(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

/** A tool's output: text, or text with images the model reads beside it. */
export type ToolOutput =
	| string
	| {
			text: string;
			images?: readonly { mimeType: string; data: Uint8Array }[];
	  };

/** `output` in the shape Pi expects: a text part, then one image part for each image. */
export function toolOutput(output: ToolOutput) {
	if (typeof output === "string") return toolText(output);
	return {
		content: [
			{ type: "text" as const, text: output.text },
			...(output.images ?? []).map((image) => ({
				type: "image" as const,
				data: Buffer.from(image.data).toString("base64"),
				mimeType: image.mimeType,
			})),
		],
		details: {},
	};
}

/** A refused call's reason, which the model reads as the tool's error result. */
export function toolError(text: string) {
	return { ...toolText(text), isError: true };
}
