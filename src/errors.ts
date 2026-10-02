/** A drawing request the renderer cannot honour; its message says what to change and is meant for the model to read. */
export class DrawingError extends Error {
	override name = "DrawingError";
}
