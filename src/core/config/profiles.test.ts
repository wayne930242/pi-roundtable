import { expect, test } from "bun:test";
import { ConfigError } from "../domain/errors.ts";
import { type RoundtableConfig, resolveConfig } from "./config.ts";
import { profileRulesOf } from "./profiles.ts";

const OWNER = "966666600000000001";
const base: RoundtableConfig = {
	access: {
		owners: [
			{ name: "Ada", principal: OWNER, identities: [`discord:${OWNER}`] },
		],
	},
	agentServer: false,
	database: { url: "postgres://localhost/roundtable" },
	dataDir: "/data",
	attachments: {},
	model: "anthropic/claude-sonnet-5-5",
};

test("profiles default to no preference and no model-visible provider, so names stay as they were", () => {
	expect(resolveConfig(base).profiles).toEqual({
		prefer: [],
		modelVisible: [],
	});
});

test("profiles.prefer and profiles.modelVisible are read as written", () => {
	const config = resolveConfig({
		...base,
		profiles: {
			prefer: ["line", "oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20"],
			modelVisible: ["line"],
		},
	});
	expect(config.profiles).toEqual({
		prefer: ["line", "oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20"],
		modelVisible: ["line"],
	});
});

test("a blank, a bare oidc and a repeated provider are refused, naming the key", () => {
	expect(() => profileRulesOf({ prefer: [" "] })).toThrow(ConfigError);
	expect(() => profileRulesOf({ prefer: [" "] })).toThrow(
		"config profiles.prefer[0]",
	);
	expect(() => profileRulesOf({ modelVisible: ["oidc"] })).toThrow(
		"config profiles.modelVisible[0]: an OIDC provider is written oidc:<base64url issuer>",
	);
	expect(() => profileRulesOf({ prefer: ["line", "line"] })).toThrow(
		"profiles.prefer[1]: line is listed twice",
	);
});

test("the schema refuses a profiles key of the wrong shape", () => {
	expect(() =>
		resolveConfig({ ...base, profiles: { prefer: "line" } } as never),
	).toThrow(ConfigError);
});
