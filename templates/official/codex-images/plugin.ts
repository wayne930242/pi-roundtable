// Warning: this plugin uses ChatGPT's undocumented Codex backend, signed in with the owner's own
// ChatGPT subscription (the `openai-codex` login), to draw images. OpenAI has not published it
// as an API, so it can stop working without notice, and OpenAI's terms for the subscription
// apply to it. Use it only where you accept that risk.

import { createCodexImages } from "pi-roundtable/kit";

export {
	type CodexFetch,
	type CodexImagesOptions,
	createCodexImages,
	ImageNotGeneratedError,
} from "pi-roundtable/kit";

/** The plugin the project lists. The client and the plugin are the kit's; this file is yours to change. */
export const codexImages = createCodexImages();
