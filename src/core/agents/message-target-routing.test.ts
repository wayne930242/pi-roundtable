import { describe, expect, test } from "bun:test";
import type { ResolvedRouting } from "../config/routing.ts";
import type { Agent } from "./agent-store.ts";
import { messageTarget } from "./message-target.ts";
import { Routes } from "./routes.ts";

const infra: Agent = {
	name: "infra",
	displayName: "Infra",
	prompt: "",
	avatarPrompt: "",
	channelId: "2000",
	status: "active",
};
const store = { agent: () => infra, group: () => undefined } as never;

function target(
	routing: ResolvedRouting | undefined,
	latest: string | undefined,
	from: string,
	ask?: string,
) {
	const roomSurfaces = ["app"];
	return messageTarget(
		{
			store,
			roomSurfaces,
			latest: latest as never,
			from: from as never,
			routes: new Routes({
				routing,
				store,
				roomSurfaces: () => roomSurfaces,
				latest: () => latest as never,
			}),
		},
		infra,
		ask,
	);
}

const pinned: ResolvedRouting = {
	agents: { infra: { primary: "app", agentMessage: "primary" } },
	places: {},
};
const onWeb: ResolvedRouting = {
	agents: { infra: { primary: "app" } },
	places: {},
};

describe("message_agent's default conversation goes through the routing table (R6)", () => {
	test("without routing it is the target's place on the sender's surface, whatever it used last", () => {
		expect(target(undefined, "app:agent.infra", "discord:4000")).toBe(
			"discord:2000",
		);
		expect(target(undefined, "discord:2000", "app:agent.coder")).toBe(
			"app:agent.infra",
		);
	});

	test("an explicit primary place leaves the sender's surface the default", () => {
		expect(target(onWeb, "app:agent.infra", "discord:4000")).toBe(
			"discord:2000",
		);
		expect(target(onWeb, undefined, "discord:4000")).toBe("discord:2000");
	});

	test("a rule that pins messages to the primary place ignores where the agent last ran", () => {
		expect(target(pinned, "discord:2000", "discord:4000")).toBe(
			"app:agent.infra",
		);
	});

	test("a conversation the sender names beats every rule", () => {
		expect(target(pinned, undefined, "discord:4000", "discord")).toBe(
			"discord:2000",
		);
		expect(target(pinned, undefined, "discord:4000", "app:agent.infra")).toBe(
			"app:agent.infra",
		);
	});
});
