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

const refused = (input: unknown): string => {
	try {
		resolveConfig(input);
	} catch (error) {
		if (error instanceof ConfigError) return error.message;
		throw error;
	}
	return "";
};

test("the shutdown's abort grace and refusal of waiting messages take 10 and 15 seconds unless the config sets them, within their ranges", () => {
	expect(resolveConfig(minimal)).toMatchObject({
		abortGraceMs: 10_000,
		refuseWaitingMs: 15_000,
	});
	expect(
		resolveConfig({
			...minimal,
			abortGraceSeconds: 3,
			refuseWaitingSeconds: 4,
		}),
	).toMatchObject({ abortGraceMs: 3_000, refuseWaitingMs: 4_000 });
	expect(refused({ ...minimal, abortGraceSeconds: 0 })).toContain(
		"config abortGraceSeconds",
	);
	expect(refused({ ...minimal, refuseWaitingSeconds: 601 })).toContain(
		"config refuseWaitingSeconds",
	);
});
