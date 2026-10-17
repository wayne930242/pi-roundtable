import { expect, test } from "bun:test";
import * as core from "../core/images/codex-image.ts";
import * as plugin from "../core/images/codex-images-plugin.ts";
import * as kit from "./index.ts";

test("the kit exports the Codex image client and plugin factory themselves", () => {
	expect(kit.drawCodexImage).toBe(core.drawCodexImage);
	expect(kit.ImageNotGeneratedError).toBe(core.ImageNotGeneratedError);
	expect(kit.CODEX_IMAGE_MODEL).toBe(core.CODEX_IMAGE_MODEL);
	expect(kit.CODEX_IMAGES_PROVIDER).toBe(core.CODEX_IMAGES_PROVIDER);
	expect(kit.createCodexImages).toBe(plugin.createCodexImages);
	expect(kit.CODEX_IMAGES_PROVIDER).toBe("openai-codex");
	expect(kit.CODEX_IMAGE_MODEL).toBe("gpt-6-sol");
});

test("what the client throws for an image that was not drawn is the kit's ImageNotGeneratedError", async () => {
	const claims = {
		"https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
	};
	const token = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
	const done = JSON.stringify({
		type: "response.completed",
		response: { output: [] },
	});
	const failure = await kit
		.drawCodexImage({
			token,
			prompt: "a fox",
			fetch: async () => new Response(`data: ${done}\n\n`),
		})
		.then(
			() => undefined,
			(error: unknown) => error,
		);
	expect(failure).toBeInstanceOf(kit.ImageNotGeneratedError);
	expect((failure as Error).name).toBe("ImageNotGeneratedError");
});
