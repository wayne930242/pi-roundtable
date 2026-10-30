import { expect, test } from "bun:test";
import { TEST_OWNER } from "../testing/owner.ts";
import { agentSystemPrompt, placeOf } from "./agent-prompt.ts";
import type { Agent } from "./agent-store.ts";

const agent: Agent = {
	name: "coder",
	displayName: "Coder",
	prompt: "",
	avatarPrompt: "",
	channelId: "4000",
	status: "active",
};

const surfaces = {
	of: (key: string) =>
		key.startsWith("app:") ? { label: "the web app" } : undefined,
	roomSurfaces: () => ["app"],
} as never;

const build = (home: `${string}:${string}`) =>
	agentSystemPrompt({
		agent,
		shared: "shared",
		workDir: "/w",
		owner: TEST_OWNER,
		shellUser: "u",
		...placeOf(home, surfaces, true),
	});

test("an app room's prompt names the web app and the other places, not Discord as home", () => {
	const text = build("app:agent.coder");
	expect(text).toContain("This conversation is in the web app (app).");
	expect(text).toContain("You also have places on Discord.");
	expect(text).not.toContain("Discord agent server");
});

test("a Discord channel's prompt names Discord and the web app", () => {
	const text = build("discord:4000");
	expect(text).toContain("This conversation is in Discord (discord).");
	expect(text).toContain("You also have places on the web app.");
});
