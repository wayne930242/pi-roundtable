import { expect, test } from "bun:test";
import { ConfigError } from "../domain/errors.ts";
import { type RoundtableConfig, resolveConfig } from "./config.ts";

const minimal: RoundtableConfig = {
	owner: { id: "100000000000000001", name: "Ada" },
	discord: {
		token: "token",
		guild: "900000000000000001",
		entryChannel: "900000000000000002",
	},
	database: { url: "postgres://localhost/roundtable" },
	dataDir: "/data",
	model: "anthropic/claude-sonnet-5-5",
	http: { publicUrl: "https://bot.example.com" },
};

const withRead = (attachmentRead: unknown) =>
	resolveConfig({
		...minimal,
		discord: { ...minimal.discord, attachmentRead },
	} as RoundtableConfig).discord?.attachmentRead;

const refusal = (attachmentRead: unknown): string => {
	try {
		withRead(attachmentRead);
	} catch (error) {
		if (error instanceof ConfigError) return error.message;
		throw error;
	}
	return "";
};

test("discord.attachmentRead is left out unless configured, so the 10 MiB default applies", () => {
	expect(resolveConfig(minimal).discord?.attachmentRead).toBeUndefined();
});

test("discord.attachmentRead takes maxBytes up to 100 MiB", () => {
	expect(withRead({ maxBytes: 2_000_000 })).toEqual({ maxBytes: 2_000_000 });
	expect(withRead({ maxBytes: 100 * 1024 * 1024 })).toEqual({
		maxBytes: 100 * 1024 * 1024,
	});
});

test("discord.attachmentRead refuses a cap out of range or a key it does not know, naming it", () => {
	expect(refusal({ maxBytes: 0 })).toContain(
		"config discord.attachmentRead.maxBytes",
	);
	expect(refusal({ maxBytes: 100 * 1024 * 1024 + 1 })).toContain(
		"config discord.attachmentRead.maxBytes",
	);
	expect(refusal({ maxByte: 5 })).toContain('Did you mean "maxBytes"?');
});
