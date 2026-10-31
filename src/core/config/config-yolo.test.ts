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

test("yolo's card waits are 30 seconds and one minute unless the config sets them, within their ranges", () => {
	expect(
		resolveConfig({
			...minimal,
			autonomy: {
				yolo: { questionGraceSeconds: 10, timeoutCardSeconds: 120 },
			},
		}).autonomy.yolo,
	).toEqual({
		allow: [],
		card: [],
		questionGraceMs: 10_000,
		timeoutCardGraceMs: 120_000,
	});
	for (const [key, value] of [
		["questionGraceSeconds", 4],
		["questionGraceSeconds", 601],
		["timeoutCardSeconds", 9],
		["timeoutCardSeconds", 3_601],
		["questionGraceSeconds", "30"],
	] as const)
		expect(
			refused({ ...minimal, autonomy: { yolo: { [key]: value } } }),
		).toContain(`config autonomy.yolo.${key}`);
	expect(
		refused({
			...minimal,
			autonomy: { yolo: { questionGraceSeconds: 5, timeoutCardSeconds: 10 } },
		}),
	).toBe("");
});
