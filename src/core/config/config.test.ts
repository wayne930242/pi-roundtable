import { describe, expect, test } from "bun:test";
import { ConfigError } from "../domain/errors.ts";
import { type RoundtableConfig, resolveConfig } from "./config.ts";

const discord = {
	token: "token",
	guild: "900000000000000001",
	entryChannel: "900000000000000002",
};

const minimal: RoundtableConfig = {
	owner: { id: "100000000000000001", name: "Ada" },
	discord,
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

describe("resolveConfig", () => {
	test("fills every default from a minimal configuration", () => {
		const config = resolveConfig(minimal);
		expect(config.name).toBe("Roundtable");
		expect(config.owner).toEqual({
			id: "100000000000000001",
			name: "Ada",
			pronouns: { subject: "they", object: "them", possessive: "their" },
		});
		expect(config.discord?.rootCommand).toBe("roundtable");
		expect(config.agentDir).toBe("/data/pi");
		expect(config.model).toEqual({
			provider: "anthropic",
			id: "claude-sonnet-5-5",
		});
		expect(config.thinking).toBe("medium");
		expect(config.judge).toEqual({ model: config.model, threshold: 0.6 });
		expect(config.delegation).toEqual({
			model: config.model,
			thinking: "medium",
		});
		expect(config.locale).toBe("en");
		expect(config.timeZone).toBe("UTC");
		expect(config.http?.port).toBe(3000);
		expect(config.agents).toEqual([]);
		expect(config.plugins).toEqual([]);
	});

	test("the root command follows the assistant's name unless one is given", () => {
		expect(
			resolveConfig({ ...minimal, name: "Robin Hood" }).discord?.rootCommand,
		).toBe("robin-hood");
		expect(
			resolveConfig({
				...minimal,
				discord: { ...discord, rootCommand: "rh" },
			}).discord?.rootCommand,
		).toBe("rh");
	});

	test("pronouns become the words prompts use", () => {
		const owner = { ...minimal.owner, pronouns: "she" as const };
		expect(resolveConfig({ ...minimal, owner }).owner.pronouns).toEqual({
			subject: "she",
			object: "her",
			possessive: "her",
		});
	});

	test("attachment retention is off by default, and kept as given", () => {
		expect(resolveConfig(minimal).attachments).toEqual({});
		expect(
			resolveConfig({
				...minimal,
				attachments: { retention: { maxAgeMs: 604_800_000 } },
			}).attachments,
		).toEqual({ retention: { maxAgeMs: 604_800_000 } });
		expect(
			resolveConfig({
				...minimal,
				attachments: {
					retention: { maxAgeMs: 604_800_000, sweepEveryMs: 600_000 },
				},
			}).attachments.retention,
		).toEqual({ maxAgeMs: 604_800_000, sweepEveryMs: 600_000 });
		expect(
			refused({ ...minimal, attachments: { retention: { maxAgeMs: 0 } } }),
		).toContain("config attachments.retention.maxAgeMs");
		expect(refused({ ...minimal, attachments: { retention: {} } })).toContain(
			"config attachments.retention.maxAgeMs",
		);
		expect(
			refused({
				...minimal,
				attachments: { retention: { maxAgeMs: 1_000, sweepEveryMs: 0.5 } },
			}),
		).toContain("config attachments.retention.sweepEveryMs");
	});

	test("each person's background limits are unset by default, and set as given", () => {
		expect(resolveConfig(minimal).background).toEqual({ perPrincipal: {} });
		expect(
			resolveConfig({
				...minimal,
				background: { perPrincipal: { schedules: 10, delegations: 2 } },
			}).background,
		).toEqual({ perPrincipal: { schedules: 10, delegations: 2 } });
		expect(
			refused({ ...minimal, background: { perPrincipal: { schedules: 0 } } }),
		).toContain("config background.perPrincipal.schedules");
		expect(
			refused({
				...minimal,
				background: { perPrincipal: { delegations: 1.5 } },
			}),
		).toContain("config background.perPrincipal.delegations");
	});

	test("an unknown key names the nearest known key, at any depth", () => {
		expect(refused({ ...minimal, discrod: {} })).toStartWith(
			'config discrod: unknown key. Did you mean "discord"? The keys here are name, owner, discord,',
		);
		expect(
			refused({ ...minimal, discord: { ...discord, tokn: "x" } }),
		).toContain('config discord.tokn: unknown key. Did you mean "token"?');
	});

	test("a missing required key names it and the fix", () => {
		const { model: _model, ...without } = minimal;
		expect(refused(without)).toBe(
			"config model: required, expected a non-empty string. Add it to roundtable.config.ts.",
		);
		expect(refused({ ...minimal, owner: { name: "Ada" } })).toBe(
			"config owner.id: required, expected a non-empty string. Add it to roundtable.config.ts.",
		);
	});

	test("a wrong value says what was expected and what it got", () => {
		expect(refused({ ...minimal, thinking: "loud" })).toBe(
			'config thinking: expected one of off, minimal, low, medium, high, xhigh, got "loud". Fix the value in roundtable.config.ts.',
		);
		expect(
			refused({ ...minimal, http: { publicUrl: "https://x", port: 70000 } }),
		).toContain(
			"config http.port: expected an integer from 1 to 65535, got 70000.",
		);
		expect(
			refused({
				...minimal,
				http: { publicUrl: "https://x", socketMode: 0o1000 },
			}),
		).toContain("config http.socketMode: expected an integer from 0 to 511");
		expect(refused({ ...minimal, model: "sonnet" })).toBe(
			'config model: expected <provider>/<id>, got "sonnet". Write it like anthropic/claude-sonnet-5-5.',
		);
		expect(refused({ ...minimal, locale: "fr" })).toContain(
			"config locale: expected a locale, en or zh-TW",
		);
		expect(refused({ ...minimal, toolTiers: { shell: "root" } })).toContain(
			"config toolTiers.shell: expected one of owner, admin, member",
		);
		expect(refused({ ...minimal, plugins: [{ name: "x" }] })).toContain(
			"config plugins[0]: expected a plugin, an object with a name and a setup function",
		);
		expect(refused("nope")).toContain("expected an object");
	});

	test("agents are seeds with their four texts", () => {
		const seed = {
			name: "coordinator",
			displayName: "Coordinator",
			prompt: "You coordinate.",
			avatarPrompt: "A calm coordinator.",
			channelId: "900000000000000002",
		};
		expect(resolveConfig({ ...minimal, agents: [seed] }).agents).toEqual([
			seed,
		]);
		expect(refused({ ...minimal, agents: [{ name: "x" }] })).toContain(
			"config agents[0].displayName: required",
		);
	});
});

describe("the addon switches", () => {
	test("are on unless configured off", () => {
		const config = resolveConfig(minimal);
		expect(config.memory).toBe(true);
		expect(config.discord?.admin).toBe(true);
		expect(config.skills).toEqual({});
	});

	test("discord.agentMemory is everyone by default, owners when asked, and nothing else", () => {
		expect(resolveConfig(minimal).discord?.agentMemory).toBeUndefined();
		expect(
			resolveConfig({
				...minimal,
				discord: { ...discord, agentMemory: "owners" },
			}).discord?.agentMemory,
		).toBe("owners");
		expect(
			refused({ ...minimal, discord: { ...discord, agentMemory: "members" } }),
		).toContain("agentMemory");
	});

	test("turn each addon off, and keep skills' directories when they are on", () => {
		const off = resolveConfig({
			...minimal,
			memory: false,
			skills: false,
			discord: { ...discord, admin: false },
		});
		expect(off.memory).toBe(false);
		expect(off.skills).toBe(false);
		expect(off.discord?.admin).toBe(false);
		expect(
			resolveConfig({ ...minimal, skills: { reposDir: "/repos" } }).skills,
		).toEqual({ reposDir: "/repos" });
	});

	test("refuse anything else, naming the key", () => {
		expect(() => resolveConfig({ ...minimal, skills: true })).toThrow(
			"config skills",
		);
		expect(() => resolveConfig({ ...minimal, memory: "no" })).toThrow(
			"config memory: expected true or false",
		);
	});
});

describe("discord.channelContext", () => {
	test("is on with the defaults unless configured", () => {
		expect(resolveConfig(minimal).discord?.channelContext).toEqual({});
	});

	test("takes false to turn it off, or the options it changes", () => {
		const with_ = (channelContext: unknown) =>
			resolveConfig({
				...minimal,
				discord: { ...discord, channelContext },
			} as RoundtableConfig).discord?.channelContext;
		expect(with_(false)).toBe(false);
		expect(with_({ keep: 5, similarity: 0.9 })).toEqual({
			keep: 5,
			similarity: 0.9,
		});
	});

	test("refuses a value out of range or a key it does not know, naming it", () => {
		const with_ = (channelContext: unknown) =>
			refused({ ...minimal, discord: { ...discord, channelContext } });
		expect(with_({ fetch: 101 })).toContain(
			"config discord.channelContext.fetch: expected an integer from 1 to 100",
		);
		expect(with_({ similarity: 2 })).toContain(
			"config discord.channelContext.similarity",
		);
		expect(with_({ kep: 3 })).toContain('Did you mean "keep"?');
		expect(with_(true)).toContain("config discord.channelContext");
	});
});

describe("discord.freshMarker", () => {
	const with_ = (freshMarker: unknown) =>
		resolveConfig({
			...minimal,
			discord: { ...discord, freshMarker },
		} as RoundtableConfig).discord?.freshMarker;

	test("is left out unless configured, so the default divider applies", () => {
		expect(resolveConfig(minimal).discord?.freshMarker).toBeUndefined();
	});

	test("takes a text, or false for no divider", () => {
		expect(with_("--- reset ---")).toBe("--- reset ---");
		expect(with_(false)).toBe(false);
	});

	test("refuses true or a number, naming the key", () => {
		expect(
			refused({ ...minimal, discord: { ...discord, freshMarker: true } }),
		).toContain("config discord.freshMarker");
	});
});

describe("a host without Discord", () => {
	const { discord: _discord, http: _http, ...headless } = minimal;

	test("resolves with no Discord, no listener, and the skills addon off", () => {
		const config = resolveConfig(headless);
		expect(config.discord).toBeUndefined();
		expect(config.http).toBeUndefined();
		expect(config.skills).toBe(false);
		expect(config.slug).toBe("roundtable");
		expect(config.scratchDir).toEndWith("roundtable-scratch");
		expect(resolveConfig({ ...headless, name: "Robin Hood" }).slug).toBe(
			"robin-hood",
		);
		expect(resolveConfig({ ...headless, http: { port: 8080 } }).http).toEqual({
			port: 8080,
		});
	});

	test("Discord's slug is its root command, so an existing host keeps its logger and scratch dir", () => {
		const config = resolveConfig({
			...minimal,
			discord: { ...discord, rootCommand: "rh" },
		});
		expect(config.slug).toBe("rh");
		expect(config.discord?.rootCommand).toBe("rh");
		expect(config.http?.publicUrl).toBe("https://bot.example.com");
	});

	test("Discord still needs the public address its agents' avatars are served from", () => {
		expect(refused({ ...minimal, http: undefined })).toContain(
			"config http.publicUrl: required with discord",
		);
		expect(refused({ ...minimal, http: { port: 8080 } })).toContain(
			"config http.publicUrl: required with discord",
		);
	});

	test("what only the agent server serves is refused without Discord, naming the key", () => {
		expect(
			refused({
				...headless,
				agents: [
					{ name: "a", displayName: "A", prompt: "p", avatarPrompt: "q" },
				],
			}),
		).toContain("config agents: the agents live in Discord");
		expect(refused({ ...headless, skills: {} })).toContain(
			"config skills: the skills are the agents'",
		);
		expect(refused({ ...headless, ops: { agent: "infra" } })).toContain(
			"config ops.agent: the agents live in Discord",
		);
		expect(resolveConfig({ ...headless, skills: false }).skills).toBe(false);
		expect(resolveConfig({ ...headless, agents: [] }).agents).toEqual([]);
	});

	test("the shutdown drain waits three minutes unless the config says otherwise", () => {
		expect(resolveConfig(minimal).drainMs).toBe(180_000);
		expect(resolveConfig({ ...minimal, drainSeconds: 45 }).drainMs).toBe(
			45_000,
		);
		expect(refused({ ...minimal, drainSeconds: 0 })).toContain(
			"config drainSeconds",
		);
	});

	test("the ops reports go to an agent or to a conversation, one of them", () => {
		expect(resolveConfig({ ...minimal, ops: { agent: "infra" } }).ops).toEqual({
			agent: "infra",
		});
		expect(
			resolveConfig({ ...headless, ops: { conversation: "room:ops" } }).ops,
		).toEqual({ conversation: "room:ops" });
		expect(
			refused({
				...minimal,
				ops: { agent: "infra", conversation: "room:ops" },
			}),
		).toContain("config ops: name an agent or a conversation, not both");
		expect(refused({ ...minimal, ops: {} })).toContain(
			"config ops: name an agent or a conversation",
		);
		expect(refused({ ...headless, ops: { conversation: "ops" } })).toContain(
			"config ops.conversation: expected a conversation key <surface>:<id>",
		);
	});
});

describe("the adapters key", () => {
	const { discord: _discord, ...rest } = minimal;
	const adapter = { adapter: "discord", discord } as const;

	test("a Discord adapter resolves as the top-level discord does", () => {
		expect(resolveConfig({ ...rest, adapters: [adapter] })).toEqual(
			resolveConfig(minimal),
		);
		expect(resolveConfig({ ...rest, adapters: [] }).discord).toBeUndefined();
	});

	test("Discord is configured once: at the top level or in adapters", () => {
		expect(refused({ ...minimal, adapters: [adapter] })).toContain(
			"config adapters[0]: Discord is configured twice",
		);
		expect(refused({ ...rest, adapters: [adapter, adapter] })).toContain(
			"config adapters[1]: Discord is configured twice",
		);
	});

	test("an adapter is one the host knows, with options it can read, named by its place", () => {
		expect(refused({ ...rest, adapters: [{ adapter: "slack" }] })).toContain(
			'config adapters[0]: unknown adapter "slack"',
		);
		expect(refused({ ...rest, adapters: ["discord"] })).toContain(
			"config adapters[0]: expected an adapter",
		);
		expect(refused({ ...rest, adapters: adapter })).toContain(
			"config adapters: expected a list of adapters",
		);
		expect(
			refused({
				...rest,
				adapters: [{ adapter: "discord", discord: { ...discord, token: "" } }],
			}),
		).toContain(
			"config adapters[0].discord.token: expected a non-empty string",
		);
	});
});
