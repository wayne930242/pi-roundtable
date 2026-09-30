/** The text a tool returns, in the shape Pi expects. */
export function toolText(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

/** A refused call's reason, which the model reads as the tool's error result. */
export function toolError(text: string) {
	return { ...toolText(text), isError: true };
}
