import { definePlugin } from "pi-roundtable";

// A one-pixel PNG standing in for a real image service.
const PIXEL = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

/** A provider fills a slot the core otherwise runs on its default; one plugin may fill each slot. */
export const pixelAvatars = definePlugin({
	name: "pixel-avatars",
	providers: {
		// The images slot draws an agent's avatar from a prompt and reference pictures.
		images: async (_prompt, _references) => new Uint8Array(PIXEL),
	},
	setup: () => ({}),
});
