import { describe, expect, test } from "bun:test";
import { ConfigError } from "../domain/errors.ts";
import {
	OPS_DEPRECATION,
	type RoundtableConfig,
	resolveConfig,
} from "./config.ts";

const discord = {
	token: "token",
	guild: "900000000000000001",
	entryChannel: "900000000000000002",
};

const base: RoundtableConfig = {
	owner: { id: "100000000000000001", name: "Ada" },
	discord,
	database: { url: "postgres://localhost/roundtable" },
	dataDir: "/data",
	model: "anthropic/claude-sonnet-5-5",
	http: { publicUrl: "https://bot.example.com" },
};

/** A host with no Discord whose agents live in rooms. */
const rooms: RoundtableConfig = {
	owner: base.owner,
	database: base.database,
	dataDir: "/data",
	model: base.model,
	agents: [{ name: "infra", displayName: "Infra", prompt: "You watch." }],
} as RoundtableConfig;

const refused = (input: unknown): string => {
	try {
		resolveConfig(input);
	} catch (error) {
		if (error instanceof ConfigError) return error.message;
		throw error;
	}
	return "";
};

describe("routing", () => {
	test("a configuration without it resolves exactly as before: no routing, no deprecation", () => {
		const config = resolveConfig(base);
		expect(config.routing).toBeUndefined();
		expect(config.ops).toBeUndefined();
		expect(config.deprecations).not.toContain(OPS_DEPRECATION);
	});

	test("the target example resolves: Infra's primary place on the web app, and its alerts there", () => {
		const config = resolveConfig({
			...base,
			routing: {
				agents: { infra: { primary: "app", integration: "primary" } },
				places: { ops: { agent: "infra" } },
			},
		});
		expect(config.routing).toEqual({
			agents: { infra: { primary: "app", integration: "primary" } },
			places: { ops: { agent: "infra" } },
		});
		expect(config.ops).toEqual({ agent: "infra" });
		expect(config.opsKey).toBe("routing.places.ops");
		expect(config.deprecations).not.toContain(OPS_DEPRECATION);
	});

	test("a support desk without Discord resolves: a default for every agent, and named conversations", () => {
		const config = resolveConfig({
			...rooms,
			routing: {
				agents: {
					"*": { primary: "app" },
					infra: { integration: "primary", agentMessage: "primary" },
				},
				places: { ops: "slack:C0OPS" },
			},
		});
		expect(config.ops).toEqual({ conversation: "slack:C0OPS" });
		expect(config.routing?.agents["*"]).toEqual({ primary: "app" });
	});

	test("the ops place may be an agent on a host without Discord, which the top-level ops refuses", () => {
		const config = resolveConfig({
			...rooms,
			routing: { places: { ops: { agent: "infra" } } },
		});
		expect(config.ops).toEqual({ agent: "infra" });
		expect(refused({ ...rooms, ops: { agent: "infra" } })).toContain(
			"config ops.agent: the agents live in Discord",
		);
	});

	test("the top-level ops still works, as a deprecated alias of the ops place", () => {
		const config = resolveConfig({ ...base, ops: { agent: "infra" } });
		expect(config.ops).toEqual({ agent: "infra" });
		expect(config.opsKey).toBe("ops");
		expect(config.deprecations).toContain(OPS_DEPRECATION);
		expect(OPS_DEPRECATION).toContain("routing.places.ops");
	});

	test("both ops and routing.places.ops is refused: keep one", () => {
		const message = refused({
			...base,
			ops: { agent: "infra" },
			routing: { places: { ops: { agent: "infra" } } },
		});
		expect(message).toContain("config routing.places.ops");
		expect(message).toContain("Keep one");
	});
});

describe("routing validation", () => {
	const routing = (value: unknown) => refused({ ...base, routing: value });

	test("a key the block does not have names the nearest one", () => {
		expect(routing({ agent: {} })).toContain(
			'config routing.agent: unknown key. Did you mean "agents"?',
		);
		expect(routing({ agents: { infra: { primry: "app" } } })).toContain(
			'config routing.agents.infra.primry: unknown key. Did you mean "primary"?',
		);
	});

	test("an agent key must be an agent name or *", () => {
		const message = routing({ agents: { "Not An Agent": {} } });
		expect(message).toContain("config routing.agents.Not An Agent");
		expect(message).toContain("lowercase letters, digits and dashes");
	});

	test("a value another kind owns is refused with the kind's own values", () => {
		const latest = routing({ agents: { infra: { integration: "latest" } } });
		expect(latest).toContain("config routing.agents.infra.integration");
		expect(latest).toContain('"latest" is not a value of integration');
		expect(latest).toContain('"origin", "primary", or a surface name');
		const origin = routing({ agents: { infra: { agentMessage: "origin" } } });
		expect(origin).toContain('"origin" is not a value of agentMessage');
		const auto = routing({ agents: { infra: { primary: "primary" } } });
		expect(auto).toContain('"primary" is not a value of primary');
		const opening = routing({ agents: { infra: { opening: "app" } } });
		expect(opening).toContain("one of origin-surface, primary");
	});

	test("a place no one declared is a typo, and the declared ones are listed", () => {
		const message = routing({ places: { alerts: "slack:C1" } });
		expect(message).toContain("config routing.places.alerts");
		expect(message).toContain("The places are ops");
	});

	test("a place that is neither a conversation key nor an agent is refused", () => {
		const message = routing({ places: { ops: "no-colon" } });
		expect(message).toContain("config routing.places.ops");
		expect(message).toContain("<surface>:<id>");
		expect(routing({ places: { ops: {} } })).toContain(
			"config routing.places.ops.agent: required",
		);
	});

	test("agents, surfaces and an agent place need the agent server", () => {
		const off = { ...base, agentServer: false } as RoundtableConfig;
		for (const value of [
			{ agents: { infra: { primary: "app" } } },
			{ surfaces: { app: { agentPlaces: "all" } } },
			{ places: { ops: { agent: "infra" } } },
		]) {
			const message = refused({ ...off, routing: value });
			expect(message).toContain("config routing:");
			expect(message).toContain("need the agent server");
		}
		// A conversation place needs no agents, so it stays allowed.
		expect(
			resolveConfig({ ...off, routing: { places: { ops: "slack:C1" } } }).ops,
		).toEqual({ conversation: "slack:C1" });
	});

	test("discord cannot be named on a host without it", () => {
		const message = refused({
			...rooms,
			routing: { agents: { infra: { integration: "discord" } } },
		});
		expect(message).toContain("config routing.agents.infra.integration");
		expect(message).toContain("Discord is not configured");
		expect(
			refused({ ...rooms, routing: { surfaces: { discord: {} } } }),
		).toContain("config routing.surfaces.discord");
	});

	test("the places that are defined and not built stop the start, naming the key and the fix", () => {
		const mirror = routing({ agents: { infra: { mirror: ["app"] } } });
		expect(mirror).toContain("config routing.agents.infra.mirror");
		expect(mirror).toContain("not built yet");
		const places = routing({ surfaces: { discord: { agentPlaces: "none" } } });
		expect(places).toContain("config routing.surfaces.discord.agentPlaces");
		expect(places).toContain('write "all"');
		const answered = routing({ surfaces: { app: { answeredBy: "x" } } });
		expect(answered).toContain("config routing.surfaces.app.answeredBy");
		expect(answered).toContain("claim priorities decide");
	});

	test('the default `agentPlaces: "all"` and an empty mirror are what every host already has', () => {
		const config = resolveConfig({
			...base,
			routing: {
				agents: { infra: { mirror: [] } },
				surfaces: { discord: { agentPlaces: "all" } },
			},
		});
		expect(config.routing?.agents.infra).toEqual({});
	});
});
