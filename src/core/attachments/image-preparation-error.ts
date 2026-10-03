/** Image admission failed before native decoding or allocating a bitmap. */
export class ImagePreparationError extends Error {
	override readonly name = "ImagePreparationError";

	constructor(readonly reason: "byte-limit" | "pixel-limit" | "invalid-image") {
		super(
			{
				"byte-limit": "Image is larger than 25 MiB.",
				"pixel-limit": "Image exceeds the 64 MP decoded-pixel budget.",
				"invalid-image": "Image has an invalid or unsupported raster header.",
			}[reason],
		);
	}
}
