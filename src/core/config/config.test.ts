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

	test("effortPolicy is kept as given, and anything but a function is refused", () => {
		const policy = () => ({ fixed: "low" as const });
		expect(
			resolveConfig({ ...minimal, effortPolicy: policy }).effortPolicy,
		).toBe(policy);
		expect(resolveConfig(minimal).effortPolicy).toBeUndefined();
		expect(refused({ ...minimal, effortPolicy: "low" })).toContain(
			"config effortPolicy",
		);
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

	test("discord.agentSpeakers is everyone by default, owners when asked, and nothing else", () => {
		expect(resolveConfig(minimal).discord?.agentSpeakers).toBeUndefined();
		expect(
			resolveConfig({
				...minimal,
				discord: { ...discord, agentSpeakers: "owners" },
			}).discord?.agentSpeakers,
		).toBe("owners");
		expect(
			refused({
				...minimal,
				discord: { ...discord, agentSpeakers: "members" },
			}),
		).toContain("agentSpeakers");
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
		expect(
			resolveConfig({
				...minimal,
				skills: { packages: ["pi-workflow-skills"] },
			}).skills,
		).toEqual({ packages: ["pi-workflow-skills"] });
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

	test("takes a predicate for the webhooks that speak for others, and the images to fetch", () => {
		const foreignWebhook = (id: string) => id === "w";
		const given = {
			foreignWebhook,
			attachments: { images: 2, maxBytes: 1_000_000 },
		};
		const resolved = resolveConfig({
			...minimal,
			discord: { ...discord, channelContext: given },
		} as RoundtableConfig).discord?.channelContext;
		expect(resolved).toEqual(given);
	});

	test("refuses a value out of range or a key it does not know, naming it", () => {
		const with_ = (channelContext: unknown) =>
			refused({ ...minimal, discord: { ...discord, channelContext } });
		expect(with_({ foreignWebhook: "w" })).toContain(
			"config discord.channelContext.foreignWebhook",
		);
		expect(with_({ attachments: { images: 5 } })).toContain(
			"config discord.channelContext.attachments.images: expected an integer from 0 to 4",
		);
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

describe("discord.cardCopies", () => {
	const with_ = (cardCopies: unknown) =>
		resolveConfig({
			...minimal,
			discord: { ...discord, cardCopies },
		} as RoundtableConfig).discord?.cardCopies;

	test("keeps the copy texts in a file with the defaults unless configured", () => {
		expect(resolveConfig(minimal).discord?.cardCopies).toEqual({});
	});

	test("takes how long and how many, or false for memory only", () => {
		expect(with_({ keepDays: 7, keep: 20 })).toEqual({ keepDays: 7, keep: 20 });
		expect(with_(false)).toBe(false);
	});

	test("refuses a value out of range, a key it does not know, or true, naming it", () => {
		const refusing = (cardCopies: unknown) =>
			refused({ ...minimal, discord: { ...discord, cardCopies } });
		expect(refusing({ keepDays: 0 })).toContain(
			"config discord.cardCopies.keepDays",
		);
		expect(refusing({ keep: 1.5 })).toContain("config discord.cardCopies.keep");
		expect(refusing({ kep: 3 })).toContain('Did you mean "keep"?');
		expect(refusing(true)).toContain("config discord.cardCopies");
	});
});

describe("discord.attachmentDownload", () => {
	const with_ = (attachmentDownload: unknown) =>
		resolveConfig({
			...minimal,
			discord: { ...discord, attachmentDownload },
		} as RoundtableConfig).discord?.attachmentDownload;

	test("is left out unless configured, so the 60 and 10 second defaults apply", () => {
		expect(resolveConfig(minimal).discord?.attachmentDownload).toBeUndefined();
	});

	test("takes the overall deadline and the idle timeout, together or alone", () => {
		expect(with_({ deadlineMs: 90_000, idleMs: 5_000 })).toEqual({
			deadlineMs: 90_000,
			idleMs: 5_000,
		});
		expect(with_({ idleMs: 3_000 })).toEqual({ idleMs: 3_000 });
	});

	test("refuses a value out of range, a key it does not know, or a non-object, naming it", () => {
		const refusing = (attachmentDownload: unknown) =>
			refused({ ...minimal, discord: { ...discord, attachmentDownload } });
		expect(refusing({ deadlineMs: 999 })).toContain(
			"config discord.attachmentDownload.deadlineMs",
		);
		expect(refusing({ idleMs: 0.5 })).toContain(
			"config discord.attachmentDownload.idleMs",
		);
		expect(refusing({ deadline: 5_000 })).toContain(
			'Did you mean "deadlineMs"?',
		);
		expect(refusing(true)).toContain("config discord.attachmentDownload");
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

describe("discord.formatting", () => {
	const with_ = (formatting: unknown) =>
		resolveConfig({
			...minimal,
			discord: { ...discord, formatting },
		} as RoundtableConfig).discord?.formatting;

	test("is left out unless configured, so the built-in guidance applies", () => {
		expect(resolveConfig(minimal).discord?.formatting).toBeUndefined();
	});

	test("takes a text, or false for no guidance", () => {
		expect(with_("Plain text.")).toBe("Plain text.");
		expect(with_(false)).toBe(false);
	});

	test("refuses true, a number or an empty text, naming the key", () => {
		for (const formatting of [true, 3, ""])
			expect(
				refused({ ...minimal, discord: { ...discord, formatting } }),
			).toContain("config discord.formatting");
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

	const seed = (name: string) => ({
		name,
		displayName: name.toUpperCase(),
		prompt: "p",
		avatarPrompt: "q",
	});

	test("agents and skills are allowed without Discord, and agents turn the skills addon on", () => {
		const config = resolveConfig({
			...headless,
			agents: [seed("guide"), seed("scribe")],
		});
		expect(config.agents.map((agent) => agent.name)).toEqual([
			"guide",
			"scribe",
		]);
		expect(config.skills).toEqual({});
		expect(
			resolveConfig({
				...headless,
				agents: [seed("guide")],
				skills: { reposDir: "/repos" },
			}).skills,
		).toEqual({ reposDir: "/repos" });
		expect(
			resolveConfig({ ...headless, agents: [seed("guide")], skills: false })
				.skills,
		).toBe(false);
	});

	test("the coordinator is the first seed unless the configuration names another", () => {
		const agents = [seed("guide"), seed("scribe")];
		expect(resolveConfig({ ...headless, agents }).coordinator).toBe("guide");
		expect(
			resolveConfig({ ...headless, agents, coordinator: "scribe" }).coordinator,
		).toBe("scribe");
		expect(resolveConfig(headless).coordinator).toBeUndefined();
		// The entry channel's agent is the coordinator with Discord, so the key has no meaning there.
		expect(resolveConfig({ ...minimal, agents }).coordinator).toBeUndefined();
	});

	test("a coordinator needs a host without Discord, and names one of its agents", () => {
		const agents = [seed("guide")];
		expect(refused({ ...minimal, agents, coordinator: "guide" })).toContain(
			"config coordinator: the entry channel's agent is the coordinator with discord",
		);
		expect(refused({ ...headless, agents, coordinator: "nobody" })).toContain(
			'config coordinator: "nobody" is not one of agents',
		);
		expect(refused({ ...headless, coordinator: "guide" })).toContain(
			"config coordinator: needs agents",
		);
	});

	test("what needs agents or Discord is refused without them, naming the key", () => {
		expect(refused({ ...headless, skills: {} })).toContain(
			"config skills: the skills are the agents', and this host has none",
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

describe("turn limits and autonomy", () => {
	test("the turn limits are the old fixed ones unless the config says otherwise", () => {
		expect(resolveConfig(minimal).turnLimits).toEqual({
			timeoutMs: 600_000,
			maxMs: 1_800_000,
			cardMs: 300_000,
		});
		const given = resolveConfig({
			...minimal,
			turnLimits: { timeoutSeconds: 1200 },
		});
		expect(given.turnLimits).toEqual({
			timeoutMs: 1_200_000,
			// The cap follows the timeout, three times as long, unless it is given.
			maxMs: 3_600_000,
			cardMs: 300_000,
		});
		expect(
			resolveConfig({
				...minimal,
				turnLimits: { timeoutSeconds: 900, maxSeconds: 1000, cardSeconds: 60 },
			}).turnLimits,
		).toEqual({ timeoutMs: 900_000, maxMs: 1_000_000, cardMs: 60_000 });
	});

	test("a turn limit outside its range, or a cap below the timeout, is refused naming the key", () => {
		expect(
			refused({ ...minimal, turnLimits: { timeoutSeconds: 59 } }),
		).toContain("config turnLimits.timeoutSeconds");
		expect(
			refused({ ...minimal, turnLimits: { timeoutSeconds: 86_401 } }),
		).toContain("config turnLimits.timeoutSeconds");
		expect(refused({ ...minimal, turnLimits: { cardSeconds: 29 } })).toContain(
			"config turnLimits.cardSeconds",
		);
		expect(
			refused({ ...minimal, turnLimits: { cardSeconds: 3_601 } }),
		).toContain("config turnLimits.cardSeconds");
		expect(
			refused({
				...minimal,
				turnLimits: { timeoutSeconds: 900, maxSeconds: 600 },
			}),
		).toContain("config turnLimits.maxSeconds: expected at least");
		// A timeout above the default cap's third raises the default cap with it.
		expect(
			refused({ ...minimal, turnLimits: { timeoutSeconds: 86_400 } }),
		).toBe("");
		expect(refused({ ...minimal, turnLimits: { quick: 1 } })).toContain(
			"turnLimits",
		);
	});

	test("long-running work stops at four hours and yolo allows and cards nothing extra unless the config says so", () => {
		expect(resolveConfig(minimal).autonomy).toEqual({
			yolo: { allow: [], card: [] },
			longRunningMaxMs: 14_400_000,
		});
		expect(
			resolveConfig({
				...minimal,
				autonomy: {
					yolo: { allow: ["shell.rm"], card: ["shell.push", "tool:repo_push"] },
					longRunning: { maxSeconds: 7_200 },
				},
			}).autonomy,
		).toEqual({
			yolo: { allow: ["shell.rm"], card: ["shell.push", "tool:repo_push"] },
			longRunningMaxMs: 7_200_000,
		});
		expect(
			refused({ ...minimal, autonomy: { longRunning: { maxSeconds: 599 } } }),
		).toContain("config autonomy.longRunning.maxSeconds");
		expect(
			refused({
				...minimal,
				autonomy: { longRunning: { maxSeconds: 604_801 } },
			}),
		).toContain("config autonomy.longRunning.maxSeconds");
		expect(
			refused({ ...minimal, autonomy: { yolo: { allow: "shell.rm" } } }),
		).toContain("config autonomy.yolo.allow");
	});
});
