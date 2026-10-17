// The codex-images plugin: fills the images slot with drawCodexImage.

import { definePlugin } from "../define.ts";
import { PluginError } from "../errors.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import {
	CODEX_IMAGE_MODEL,
	CODEX_IMAGES_PROVIDER,
	type CodexFetch,
	drawCodexImage,
} from "./codex-image.ts";

export interface CodexImagesOptions {
	/** The request function; default the global `fetch`. */
	fetch?: CodexFetch;
	/** The model that routes the request; default `CODEX_IMAGE_MODEL`. */
	model?: string;
	/**
	 * What setup does when the openai-codex login is missing or unusable: "throw" (the default)
	 * stops the host; "warn" logs a warning, and a drawing then fails with the same PluginError.
	 */
	onMissingLogin?: "throw" | "warn";
}

const NO_LOGIN = `the host has no login for ${CODEX_IMAGES_PROVIDER}, the provider that pays for the images. Log in to the ${CODEX_IMAGES_PROVIDER} provider with Pi so the agent directory's auth.json holds it, or remove this plugin.`;

/**
 * The `codex-images` plugin. It fills `providers.images`, reads the login's token for each drawing
 * through `context.apiKey`, and aborts a drawing with the turn that asked for it.
 */
export function createCodexImages(
	options: CodexImagesOptions = {},
): RoundtablePlugin {
	const {
		fetch: fetchImpl,
		model = CODEX_IMAGE_MODEL,
		onMissingLogin = "throw",
	} = options;
	let apiKey: ((provider: string) => Promise<string | undefined>) | undefined;
	// The login refreshes its token, so each image reads it again instead of keeping the first.
	const token = async (): Promise<string> => {
		const value = await apiKey?.(CODEX_IMAGES_PROVIDER);
		if (!value) throw new PluginError(`plugin codex-images: ${NO_LOGIN}`);
		return value;
	};
	return definePlugin({
		name: "codex-images",
		providers: {
			// The images slot draws an agent's avatar from a prompt and reference pictures.
			images: async (prompt, references, drawing) =>
				(
					await drawCodexImage({
						token: await token(),
						prompt,
						references,
						model,
						signal: drawing?.signal,
						fetch: fetchImpl,
					})
				).data,
		},
		async setup(context) {
			apiKey = context.apiKey;
			try {
				await token();
			} catch (error) {
				if (onMissingLogin !== "warn" || !(error instanceof PluginError))
					throw error;
				context.logger.warn(
					`${NO_LOGIN} Drawing images fails until the login exists.`,
				);
			}
			return {};
		},
	});
}
