import { describe, expect, test } from "bun:test";
import { ConfigError } from "../domain/errors.ts";
import {
	childEnv,
	DEFAULT_SHELL_PASS,
	frozenShellEnv,
	shellChildEnv,
} from "./child-env.ts";

const HOST = {
	PATH: "/usr/bin",
	HOME: "/home/u",
	LANG: "C.UTF-8",
	LC_ALL: "C",
	LC_TIME: "en_GB.UTF-8",
	TERM: "xterm",
	https_proxy: "http://proxy:3128",
	SSL_CERT_FILE: "/etc/ssl/cert.pem",
	GH_TOKEN: "ghp_fake",
	DISCORD_TOKEN: "fake",
	DATABASE_URL: "postgres://u:p@h/db",
	ANTHROPIC_API_KEY: "sk-fake",
	PLAIN: "plain",
	UNSET: undefined,
};

describe("childEnv", () => {
	test("keeps the whitelist and drops everything else", () => {
		expect(childEnv(HOST)).toEqual({
			PATH: "/usr/bin",
			HOME: "/home/u",
			LANG: "C.UTF-8",
			LC_ALL: "C",
			LC_TIME: "en_GB.UTF-8",
			TERM: "xterm",
			https_proxy: "http://proxy:3128",
			SSL_CERT_FILE: "/etc/ssl/cert.pem",
		});
	});

	test("LC_* matches a prefix, and nothing named like it", () => {
		const env = childEnv({ LC_PAPER: "a4", LCX: "no", XLC_ALL: "no" });
		expect(env).toEqual({ LC_PAPER: "a4" });
	});

	test("pass adds names, a trailing * a prefix", () => {
		const env = childEnv(HOST, { pass: ["GH_TOKEN", "PLA*", "MISSING"] });
		expect(env.GH_TOKEN).toBe("ghp_fake");
		expect(env.PLAIN).toBe("plain");
		expect("MISSING" in env).toBe(false);
		expect("DISCORD_TOKEN" in env).toBe(false);
	});

	test("set gives fixed values that win over the host's", () => {
		const env = childEnv(HOST, { set: { HOME: "/srv/agent", NEW: "1" } });
		expect(env.HOME).toBe("/srv/agent");
		expect(env.NEW).toBe("1");
	});

	test("frozenShellEnv copies the options and refuses a bad name", () => {
		const pass = ["A"];
		const frozen = frozenShellEnv({ pass, set: { B: "1" } });
		pass.push("C");
		expect(frozen.pass).toEqual(["A"]);
		expect(() => frozenShellEnv({ pass: ["A B"] })).toThrow(ConfigError);
		expect(() => frozenShellEnv({ set: { "1X": "v" } })).toThrow(ConfigError);
	});
});

describe("shellChildEnv", () => {
	test("an agent's shell keeps GH_TOKEN unless shellEnv.pass says otherwise", () => {
		expect(DEFAULT_SHELL_PASS).toEqual(["GH_TOKEN"]);
		expect(shellChildEnv(HOST).GH_TOKEN).toBe("ghp_fake");
		expect(shellChildEnv(HOST).DISCORD_TOKEN).toBeUndefined();
		expect(shellChildEnv(HOST, { pass: [] }).GH_TOKEN).toBeUndefined();
		expect(shellChildEnv(HOST, { pass: ["PLAIN"] })).toMatchObject({
			PLAIN: "plain",
		});
		expect(shellChildEnv(HOST, { pass: ["PLAIN"] }).GH_TOKEN).toBeUndefined();
	});
});
