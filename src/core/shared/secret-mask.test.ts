import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MASK, maskSecrets, secretMaskExtension } from "./secret-mask.ts";

const ENV = {
	GH_TOKEN: "ghp_0123456789abcdef",
	DATABASE_URL: "postgres://u:hunter22@db/app",
	JWT_SIGNING: "jwt-secret-value",
	MY_PASSWORD: "correct horse",
	SHORT_KEY: "abc1234",
	PLAIN_NAME: "not-a-secret-but-long",
};

type Handler = (event: {
	toolName: string;
	content: { type: string; text?: string }[];
}) => { content?: { type: string; text?: string }[] } | undefined;

/** The tool_result handler the extension registers, over a fake Pi. */
function handler(env: Record<string, string>): Handler {
	let found: Handler | undefined;
	const pi = {
		on: (name: string, fn: Handler) => {
			if (name === "tool_result") found = fn;
		},
	};
	secretMaskExtension(() => env)(pi as unknown as ExtensionAPI);
	if (!found) throw new Error("no tool_result handler");
	return found;
}

describe("maskSecrets", () => {
	test("masks the values of secret-named variables of 8 characters or more", () => {
		const text = `token ${ENV.GH_TOKEN} url ${ENV.DATABASE_URL} jwt ${ENV.JWT_SIGNING} pw ${ENV.MY_PASSWORD}`;
		expect(maskSecrets(text, ENV)).toBe(
			`token ${MASK} url ${MASK} jwt ${MASK} pw ${MASK}`,
		);
	});

	test("leaves short values and other names alone", () => {
		const text = `${ENV.SHORT_KEY} ${ENV.PLAIN_NAME}`;
		expect(maskSecrets(text, ENV)).toBe(text);
	});
});

describe("secretMaskExtension", () => {
	test("masks bash and read output before it reaches the model", () => {
		const onResult = handler(ENV);
		const bash = onResult({
			toolName: "bash",
			content: [{ type: "text", text: `GH_TOKEN=${ENV.GH_TOKEN}\n` }],
		});
		expect(bash?.content).toEqual([
			{ type: "text", text: `GH_TOKEN=${MASK}\n` },
		]);
		const read = onResult({
			toolName: "read",
			content: [
				{ type: "text", text: `DATABASE_URL=${ENV.DATABASE_URL}` },
				{ type: "image" },
			],
		});
		expect(read?.content).toEqual([
			{ type: "text", text: `DATABASE_URL=${MASK}` },
			{ type: "image" },
		]);
	});

	test("changes nothing when no secret is in the output", () => {
		const onResult = handler(ENV);
		expect(
			onResult({
				toolName: "bash",
				content: [{ type: "text", text: `short ${ENV.SHORT_KEY}` }],
			}),
		).toBeUndefined();
	});
});
