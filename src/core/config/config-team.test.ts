import { expect, test } from "bun:test";
import { ConfigError } from "../domain/errors.ts";
import { type RoundtableConfig, resolveConfig } from "./config.ts";

const headless: RoundtableConfig = {
	owner: { id: "100000000000000001", name: "Ada" },
	database: { url: "postgres://localhost/roundtable" },
	dataDir: "/data",
	model: "anthropic/claude-sonnet-5-5",
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

test("the team keeps the id and former ids the configuration gives it", () => {
	expect(resolveConfig(headless).team).toEqual({ formerIds: [] });
	expect(
		resolveConfig({
			...headless,
			team: { id: "crew", formerIds: ["900000000000000777"] },
		}).team,
	).toEqual({ id: "crew", formerIds: ["900000000000000777"] });
	expect(refused({ ...headless, team: { id: "" } })).toContain(
		"config team.id",
	);
	expect(refused({ ...headless, team: { ids: ["a"] } })).toContain(
		"config team.ids: unknown key",
	);
});
