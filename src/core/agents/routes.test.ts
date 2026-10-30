import { describe, expect, test } from "bun:test";
import type { ResolvedRouting } from "../config/routing.ts";
import { ConfigError } from "../domain/errors.ts";
import type { ChannelKey } from "../sessions.ts";
import { Routes } from "./routes.ts";

const agent = (name: string, channelId?: string, status = "active") => ({
	name,
	displayName: name,
	prompt: "",
	avatarPrompt: "",
	status,
	...(channelId ? { channelId } : {}),
});

/** The three shapes of host: Discord and the web app, the web app alone, and Discord alone. */
const HOSTS = {
	"discord + web": {
		rooms: ["app"],
		agents: [agent("infra", "2000"), agent("coder", "4000")],
	},
	"web only": { rooms: ["app"], agents: [agent("infra"), agent("coder")] },
	"discord only": {
		rooms: [] as string[],
		agents: [agent("infra", "2000"), agent("coder", "4000")],
	},
} as const;

type HostName = keyof typeof HOSTS;

function routes(
	host: HostName,
	routing?: ResolvedRouting,
	latest: Record<string, ChannelKey> = {},
) {
	const warned: string[] = [];
	const { rooms, agents } = HOSTS[host];
	const table = new Routes({
		routing,
		// SAFETY: the table reads only `agent` of the store; a group is asked for only an unknown name.
		store: {
			agent: (name: string) => agents.find((a) => a.name === name),
			group: () => undefined,
		} as never,
		roomSurfaces: () => rooms,
		latest: (name) => latest[name],
		logger: { warn: (_fields, message) => void warned.push(message) },
	});
	return { table, warned };
}

const routing = (parts: Partial<ResolvedRouting>): ResolvedRouting => ({
	agents: {},
	places: {},
	...parts,
});

/** What each routed decision resolves to with no `routing`, as 0.26.2 decided it, on each host. */
const BEFORE: Record<
	HostName,
	{
		primary: string;
		integration: string;
		fromDiscord: string;
		fromRoom: string;
		opening: string;
		openingFromApp: string;
		nearApp: string;
		nearDiscord: string;
	}
> = {
	"discord + web": {
		primary: "discord:2000",
		integration: "discord:2000",
		fromDiscord: "discord:2000",
		fromRoom: "app:agent.infra",
		opening: "discord:2000",
		openingFromApp: "app:agent.infra",
		nearApp: "app:agent.infra",
		nearDiscord: "discord:2000",
	},
	"web only": {
		primary: "app:agent.infra",
		integration: "app:agent.infra",
		fromDiscord: "app:agent.infra",
		fromRoom: "app:agent.infra",
		opening: "app:agent.infra",
		openingFromApp: "app:agent.infra",
		nearApp: "app:agent.infra",
		nearDiscord: "app:agent.infra",
	},
	"discord only": {
		primary: "discord:2000",
		integration: "discord:2000",
		fromDiscord: "discord:2000",
		fromRoom: "discord:2000",
		opening: "discord:2000",
		openingFromApp: "discord:2000",
		nearApp: "discord:2000",
		nearDiscord: "discord:2000",
	},
};

describe("without routing, every routed decision is what 0.26.2 decided", () => {
	for (const host of Object.keys(HOSTS) as HostName[]) {
		const before = BEFORE[host];
		test(host, () => {
			const { table, warned } = routes(host);
			// R1/R2: the primary place is the first place the agent is reached in.
			expect(table.primary("infra")).toBe(before.primary as ChannelKey);
			// R4: a webhook's report runs where it was posted.
			expect(table.of("infra", "integration", "discord:2000")).toBe(
				"discord:2000",
			);
			// R6: a message to an agent that has run nowhere lands where its sender is, else its first place.
			expect(table.of("infra", "agentMessage", "discord:4000")).toBe(
				before.fromDiscord as ChannelKey,
			);
			if (HOSTS[host].rooms.length > 0)
				expect(table.of("infra", "agentMessage", "app:agent.coder")).toBe(
					before.fromRoom as ChannelKey,
				);
			// R8: an opening task runs on the surface that asked, else the first place.
			expect(table.of("infra", "opening")).toBe(before.opening as ChannelKey);
			expect(table.of("infra", "opening", "app:agent.coder")).toBe(
				before.openingFromApp as ChannelKey,
			);
			// R10: another agent's place as the asker sees it.
			expect(table.near("infra", "app:agent.coder")).toBe(
				before.nearApp as ChannelKey,
			);
			expect(table.near("infra", "discord:4000")).toBe(
				before.nearDiscord as ChannelKey,
			);
			// R5: no place is named.
			expect(table.place("ops")).toBeUndefined();
			expect(warned).toEqual([]);
		});
	}

	test("a message follows the agent's latest conversation, but never from a room out to Discord", () => {
		const web = routes("discord + web", undefined, {
			infra: "app:agent.infra",
		}).table;
		expect(web.of("infra", "agentMessage", "discord:4000")).toBe(
			"app:agent.infra",
		);
		const out = routes("discord + web", undefined, {
			infra: "discord:2000",
		}).table;
		expect(out.of("infra", "agentMessage", "discord:4000")).toBe(
			"discord:2000",
		);
		expect(out.of("infra", "agentMessage", "app:agent.coder")).toBe(
			"app:agent.infra",
		);
	});

	test("an agent with no channel and a sender outside the rooms has nowhere to be reached yet", () => {
		const host = routes("discord only");
		expect(() =>
			host.table.of("ghost", "agentMessage", "discord:4000"),
		).toThrow("ghost has no channel yet");
		expect(() => host.table.near("ghost")).toThrow("ghost has no channel yet");
	});
});

const infraOnWeb = routing({
	agents: { infra: { primary: "app", integration: "primary" } },
	places: { ops: { agent: "infra" } },
});

describe("with routing", () => {
	test("R1/R2: an agent's primary place is the surface its rules name, and `*` is every agent's default", () => {
		const { table } = routes("discord + web", infraOnWeb);
		expect(table.primary("infra")).toBe("app:agent.infra");
		expect(table.primary("coder")).toBe("discord:4000");
		const everyone = routes(
			"discord + web",
			routing({
				agents: { "*": { primary: "app" }, coder: { primary: "discord" } },
			}),
		).table;
		expect(everyone.primary("infra")).toBe("app:agent.infra");
		expect(everyone.primary("coder")).toBe("discord:4000");
		expect(everyone.primary("nobody")).toBeUndefined();
	});

	test("an agent's own rule overrides the default for that key only", () => {
		const { table } = routes(
			"discord + web",
			routing({
				agents: {
					"*": { primary: "app", integration: "primary" },
					infra: { integration: "origin" },
				},
			}),
		);
		expect(table.rules("infra")).toEqual({
			primary: "app",
			integration: "origin",
		});
		expect(table.of("infra", "integration", "discord:2000")).toBe(
			"discord:2000",
		);
		expect(table.of("coder", "integration", "discord:4000")).toBe(
			"app:agent.coder",
		);
	});

	test("R4: a webhook's report runs in the primary place, and `origin` keeps it where it was posted", () => {
		const { table } = routes("discord + web", infraOnWeb);
		expect(table.of("infra", "integration", "discord:2000")).toBe(
			"app:agent.infra",
		);
		// An agent without the rule keeps today's behaviour.
		expect(table.of("coder", "integration", "discord:4000")).toBe(
			"discord:4000",
		);
	});

	test("R4: an integration may be sent to a named surface instead of the primary place", () => {
		const { table } = routes(
			"discord + web",
			routing({ agents: { coder: { integration: "app" } } }),
		);
		expect(table.of("coder", "integration", "discord:4000")).toBe(
			"app:agent.coder",
		);
	});

	test("R4: a destination that has vanished sends the report to where it was posted, with one warning", () => {
		const { table, warned } = routes(
			"discord only",
			routing({ agents: { infra: { integration: "app" } } }),
		);
		expect(table.of("infra", "integration", "discord:2000")).toBe(
			"discord:2000",
		);
		table.of("infra", "integration", "discord:2000");
		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain("the report runs where the post was made");
	});

	test("R1: a primary surface the agent has no place on falls back to its auto place, with one warning", () => {
		const { table, warned } = routes(
			"discord only",
			routing({ agents: { infra: { primary: "app" } } }),
		);
		expect(table.primary("infra")).toBe("discord:2000");
		expect(table.primary("infra")).toBe("discord:2000");
		expect(warned).toHaveLength(1);
	});

	test("R6: `latest` stays the default even with an explicit primary place, and falls to the primary when there is none", () => {
		const known = routes("discord + web", infraOnWeb, {
			infra: "discord:2000",
		}).table;
		expect(known.of("infra", "agentMessage", "discord:4000")).toBe(
			"discord:2000",
		);
		const fresh = routes("discord + web", infraOnWeb).table;
		expect(fresh.of("infra", "agentMessage", "discord:4000")).toBe(
			"app:agent.infra",
		);
	});

	test("R6: `primary` pins messages to the primary place, even out of a room into Discord", () => {
		const pinned = routing({
			agents: {
				coder: { agentMessage: "primary" },
				infra: { agentMessage: "discord" },
			},
		});
		const { table } = routes("discord + web", pinned, {
			coder: "app:agent.coder",
			infra: "app:agent.infra",
		});
		expect(table.of("coder", "agentMessage", "discord:2000")).toBe(
			"discord:4000",
		);
		expect(table.of("infra", "agentMessage", "app:agent.coder")).toBe(
			"discord:2000",
		);
	});

	test("R6: a pinned surface the agent has no place on keeps the default and warns once", () => {
		const { table, warned } = routes(
			"discord only",
			routing({ agents: { infra: { agentMessage: "app" } } }),
		);
		expect(table.of("infra", "agentMessage", "discord:4000")).toBe(
			"discord:2000",
		);
		table.of("infra", "agentMessage", "discord:4000");
		expect(warned).toHaveLength(1);
	});

	test("R8: an opening task runs on the asking surface, or, by rule, always in the primary place", () => {
		const { table } = routes("discord + web", infraOnWeb);
		expect(table.of("infra", "opening", "discord:4000")).toBe("discord:2000");
		expect(table.of("infra", "opening", "app:agent.coder")).toBe(
			"app:agent.infra",
		);
		expect(table.of("infra", "opening")).toBe("app:agent.infra");
		const always = routes(
			"discord + web",
			routing({ agents: { "*": { primary: "app", opening: "primary" } } }),
		).table;
		expect(always.of("infra", "opening", "discord:4000")).toBe(
			"app:agent.infra",
		);
	});

	test("R10: another agent's place is its room on the asker's surface, else its primary place", () => {
		const { table } = routes("discord + web", infraOnWeb);
		expect(table.near("infra", "app:agent.coder")).toBe("app:agent.infra");
		expect(table.near("infra", "discord:4000")).toBe("app:agent.infra");
		expect(table.near("coder", "discord:4000")).toBe("discord:4000");
	});

	test("R5: the `ops` place is a conversation, or the primary place of an agent while it is active", () => {
		expect(routes("discord + web", infraOnWeb).table.place("ops")).toBe(
			"app:agent.infra",
		);
		const conversation = routes(
			"discord + web",
			routing({ places: { ops: "other:alerts" } }),
		).table;
		expect(conversation.place("ops")).toBe("other:alerts");
		const archived = new Routes({
			routing: infraOnWeb,
			store: {
				agent: () => agent("infra", "2000", "archived"),
				group: () => undefined,
			} as never,
			roomSurfaces: () => ["app"],
		});
		expect(archived.place("ops")).toBeUndefined();
		expect(archived.place("unknown")).toBeUndefined();
	});

	test('"web" names the one surface that hosts rooms, unless a surface is called web', () => {
		const { table } = routes(
			"discord + web",
			routing({ agents: { infra: { primary: "web" } } }),
		);
		expect(table.primary("infra")).toBe("app:agent.infra");
		expect(table.placeOn("infra", "web")).toBe("app:agent.infra");
		const named = new Routes({
			store: { agent: () => agent("infra"), group: () => undefined } as never,
			roomSurfaces: () => ["web", "app"],
		});
		expect(named.placeOn("infra", "web")).toBe("web:agent.infra");
	});
});

describe("validate", () => {
	const linked = (
		names: string[],
		extra: { discordChannels?: boolean } = {},
	) => ({ names, discordChannels: extra.discordChannels ?? true, ...extra });
	const refused = (
		rules: ResolvedRouting,
		names: string[],
		host?: HostName,
	) => {
		try {
			routes(host ?? "discord + web", rules).table.validate(linked(names));
		} catch (error) {
			if (error instanceof ConfigError) return error.message;
			throw error;
		}
		return "";
	};

	test("accepts the surfaces that hold agent places, and passes with no routing at all", () => {
		routes("discord + web").table.validate(linked([]));
		routes("discord + web", infraOnWeb).table.validate(
			linked(["discord", "app", "webchat"]),
		);
	});

	test("refuses a surface nothing registered, naming the key and the registered surfaces", () => {
		const message = refused(
			routing({ agents: { infra: { primary: "slack" } } }),
			["discord", "app"],
		);
		expect(message).toContain("config routing.agents.infra.primary");
		expect(message).toContain('no surface is registered as "slack"');
		expect(message).toContain("The registered surfaces are discord, app");
	});

	test("refuses a surface that is registered but holds no agent places", () => {
		const message = refused(
			routing({ agents: { "*": { integration: "line" } } }),
			["discord", "app", "line"],
		);
		expect(message).toContain("config routing.agents.*.integration");
		expect(message).toContain("the line surface holds no agent places");
		expect(message).toContain("Name one that does: discord, app");
	});

	test("refuses discord when the agents have no Discord channels", () => {
		const message = refused(
			routing({ agents: { infra: { primary: "discord" } } }),
			["discord", "app"],
			"web only",
		);
		expect(routes("web only").table.rules("infra")).toEqual({});
		try {
			routes(
				"web only",
				routing({ agents: { infra: { primary: "discord" } } }),
			).table.validate({ names: ["discord", "app"], discordChannels: false });
			expect.unreachable();
		} catch (error) {
			expect((error as Error).message).toContain(
				"the discord surface holds no agent places",
			);
			expect((error as Error).message).toContain(
				"the agents have no Discord channels",
			);
		}
		expect(message).toBe("");
	});

	test('refuses "web" when no or several surfaces host rooms', () => {
		const rules = routing({ agents: { infra: { primary: "web" } } });
		expect(refused(rules, ["discord"], "discord only")).toContain(
			'"web" stands for the one surface that hosts rooms, and none does',
		);
		const two = new Routes({
			routing: rules,
			store: { agent: () => agent("infra"), group: () => undefined } as never,
			roomSurfaces: () => ["app", "webchat"],
		});
		expect(() =>
			two.validate({ names: ["app", "webchat"], discordChannels: false }),
		).toThrow("2 do (app, webchat)");
	});

	test("warns once of the agents the rules name that the team does not have yet", () => {
		const { table, warned } = routes(
			"discord + web",
			routing({
				agents: { "*": { primary: "app" }, later: { primary: "app" } },
				places: { ops: { agent: "triage" } },
			}),
		);
		table.warnUnknown();
		expect(warned).toEqual([
			"routing names agents the team does not have yet; their rules apply once they exist",
		]);
		const quiet = routes("discord + web", infraOnWeb);
		quiet.table.warnUnknown();
		expect(quiet.warned).toEqual([]);
	});
});
