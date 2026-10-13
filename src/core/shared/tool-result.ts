import {
	isModelImage,
	MAX_IMAGES_PER_TURN,
	prepareImageBytes,
} from "../attachments/image-prep.ts";
import { ImagePreparationError } from "../attachments/image-preparation-error.ts";

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
export async function toolOutput(output: ToolOutput) {
	if (typeof output === "string") return toolText(output);
	const images = output.images ?? [];
	if (images.length > MAX_IMAGES_PER_TURN)
		return toolError(
			`the tool returned ${images.length} images; at most ${MAX_IMAGES_PER_TURN} fit in one result.`,
		);
	const parts: { type: "image"; data: string; mimeType: string }[] = [];
	for (const [index, image] of images.entries()) {
		const label = `image ${index + 1} could not be prepared`;
		const mimeType = image.mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
		if (!isModelImage({ contentType: mimeType }))
			return toolError(
				`${label}: ${image.mimeType} is not an image type the model reads (png, jpeg, gif or webp).`,
			);
		try {
			const ready = await prepareImageBytes(image.data, mimeType);
			parts.push({ type: "image", ...ready });
		} catch (error) {
			if (error instanceof ImagePreparationError)
				return toolError(`${label}: ${error.message}`);
			return toolError(
				`${label}: the bytes are not a readable ${mimeType} image.`,
			);
		}
	}
	return {
		content: [{ type: "text" as const, text: output.text }, ...parts],
		details: {},
	};
}

/** A refused call's reason, which the model reads as the tool's error result. */
export function toolError(text: string) {
	return { ...toolText(text), isError: true };
}
