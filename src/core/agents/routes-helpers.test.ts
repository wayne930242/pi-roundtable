import { expect, test } from "bun:test";
import type { ResolvedRouting } from "../config/routing.ts";
import { Routes } from "./routes.ts";

const agent = (name: string, parent?: string) => ({
	name,
	displayName: name,
	prompt: "",
	avatarPrompt: "",
	status: "active",
	...(parent ? { parent } : {}),
});

/** A researcher with one temp knight, on a host with Discord channels and the `app` rooms. */
const routes = (routing: ResolvedRouting) => {
	const agents = [
		{ ...agent("researcher"), channelId: "4000" },
		agent("researcher-1", "researcher"),
		{ ...agent("other"), channelId: "5000" },
	];
	return new Routes({
		routing,
		// SAFETY: the table reads only `agent` of the store.
		store: {
			agent: (name: string) => agents.find((a) => a.name === name),
			group: () => undefined,
		} as never,
		roomSurfaces: () => ["app"],
	});
};

test("a temp knight follows its parent's rules over the default, and none of its own is needed", () => {
	const table = routes({
		agents: {
			"*": { integration: "primary" },
			researcher: { primary: "app" },
		},
		places: {},
	});
	expect(table.rules("researcher-1")).toEqual({
		integration: "primary",
		primary: "app",
	});
	// A knight that is not its parent does not share the rule.
	expect(table.rules("other")).toEqual({ integration: "primary" });
	// With primary "app" on the parent, the temp knight lives on the web too.
	expect(table.primary("researcher")).toBe("app:agent.researcher");
	expect(table.primary("researcher-1")).toBe("app:agent.researcher-1");
});

test("a row of its own, if one was written, still wins over the parent's", () => {
	const table = routes({
		agents: {
			researcher: { primary: "app" },
			"researcher-1": { primary: "discord" },
		},
		places: {},
	});
	expect(table.rules("researcher-1").primary).toBe("discord");
});

test("without routing a temp knight's place is what any knight's is: its room, since it has no channel", () => {
	const table = new Routes({
		store: {
			agent: (name: string) =>
				name === "researcher-1"
					? agent("researcher-1", "researcher")
					: undefined,
			group: () => undefined,
		} as never,
		roomSurfaces: () => ["app"],
	});
	expect(table.primary("researcher-1")).toBe("app:agent.researcher-1");
	expect(table.of("researcher-1", "agentMessage")).toBe(
		"app:agent.researcher-1",
	);
});
