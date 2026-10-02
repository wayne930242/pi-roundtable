import { definePlugin, defineTool } from "pi-roundtable";
import { Type } from "typebox";

/** A small PNG keeps this example runnable without an image provider. */
export const imageReply = definePlugin({
	name: "image-reply",
	setup: () => ({
		tools: [
			defineTool({
				name: "reply_image",
				description: "Attach a sample image to your reply.",
				parameters: Type.Object({}),
				minTier: "member",
				run: (_args, turn) => {
					turn.attachFile({
						name: "sample.png",
						data: Buffer.from(
							"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
							"base64",
						),
					});
					return "The sample image is attached to this turn's reply.";
				},
			}),
		],
	}),
});
