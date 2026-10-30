import { describe, expect, test } from "bun:test";
import { ConfigError } from "../domain/errors.ts";
import { type RoundtableConfig, resolveConfig } from "./config.ts";

const base: RoundtableConfig = {
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

describe("helpers", () => {
	test("left out, the defaults apply: 4 per knight, 12 on the host, finished ones archived after 24 hours", () => {
		expect(resolveConfig(base).helpers).toEqual({
			perParent: 4,
			perHost: 12,
			archiveFinishedAfterHours: 24,
		});
	});

	test("takes each limit on its own, and false for the sweep", () => {
		expect(
			resolveConfig({ ...base, helpers: { perParent: 2 } }).helpers,
		).toEqual({ perParent: 2, perHost: 12, archiveFinishedAfterHours: 24 });
		expect(
			resolveConfig({
				...base,
				helpers: {
					perParent: 8,
					perHost: 50,
					archiveFinishedAfterHours: false,
				},
			}).helpers,
		).toEqual({ perParent: 8, perHost: 50, archiveFinishedAfterHours: false });
	});

	test("false leaves the tools out", () => {
		expect(resolveConfig({ ...base, helpers: false }).helpers).toBe(false);
	});

	test("a value outside its range is refused, naming the key", () => {
		expect(refused({ ...base, helpers: { perParent: 0 } })).toContain(
			"helpers.perParent",
		);
		expect(refused({ ...base, helpers: { perParent: 9 } })).toContain(
			"helpers.perParent",
		);
		expect(refused({ ...base, helpers: { perHost: 51 } })).toContain(
			"helpers.perHost",
		);
		expect(
			refused({ ...base, helpers: { archiveFinishedAfterHours: 721 } }),
		).toContain("helpers.archiveFinishedAfterHours");
		expect(
			refused({ ...base, helpers: { archiveFinishedAfterHours: true } }),
		).toContain("helpers.archiveFinishedAfterHours");
		expect(refused({ ...base, helpers: { perHosts: 3 } })).toContain(
			'Did you mean "perHost"',
		);
	});

	test("a per-knight limit above the host's is refused", () => {
		const message = refused({ ...base, helpers: { perParent: 6, perHost: 5 } });
		expect(message).toContain("helpers.perParent");
		expect(message).toContain("helpers.perHost");
	});

	test("the default per-knight limit above a low host limit is refused too", () => {
		expect(refused({ ...base, helpers: { perHost: 3 } })).toContain(
			"helpers.perParent",
		);
	});

	test("agentServer false takes no helpers", () => {
		expect(
			refused({ ...base, agentServer: false, helpers: { perParent: 2 } }),
		).toContain("helpers");
		expect(
			resolveConfig({ ...base, agentServer: false, helpers: false }).helpers,
		).toBe(false);
	});
});
