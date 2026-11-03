import { expect, test } from "bun:test";
import { ZH_TW } from "../src/i18n/zh-tw.ts";
import { CORE } from "./lib/prompt-text.ts";

test("every label and description the core registers a prompt document with has its catalog wording", async () => {
	const source = await Bun.file(
		new URL("../../../src/core/builtin/agent-server.ts", import.meta.url),
	).text();
	const registered = [
		...source.matchAll(/(?:label|description):\s*"((?:[^"\\]|\\.)*)"/g),
	]
		.map((match) => match[1] ?? "")
		.filter((text) => /prompt/i.test(text));
	expect(registered.length).toBeGreaterThanOrEqual(4);
	for (const text of registered) {
		const wording = CORE[text];
		expect(wording, text).toBeDefined();
		expect(ZH_TW[wording ?? ""], text).toBeDefined();
	}
});
