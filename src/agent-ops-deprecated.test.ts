import { expect, test } from "bun:test";
import {
	duringTurn,
	ENTRY,
	fx,
	settle,
	useTeamFixture,
} from "./core/agents/agent-team-fixture.ts";
import { discordKey } from "./core/contract/discord-key.ts";
import { describeDb } from "./core/testing/database.ts";
import type { AgentOps } from "./kit/index.ts";

// Callers written against 0.45's `AgentOps`, as a plugin compiled for it calls the team: they
// name `arrange`, `read`, and the `category` of `create` and `createGroup`, which stay on the
// kit's type, deprecated, until 1.0. `tsc` compiles this file, so a member that leaves the type
// fails the typecheck here.
const coordinator = {
	name: "coordinator",
	session: discordKey(ENTRY),
	home: discordKey(ENTRY),
};
const arrange045 = (ops: AgentOps) =>
	ops.arrange([{ category: "Agents-Work", names: ["doctor"] }]);
const read045 = (ops: AgentOps, channel: string) =>
	ops.read(channel, undefined, 5);
const create045 = (ops: AgentOps) =>
	ops.create(coordinator, {
		name: "notes",
		displayName: "Notes",
		prompt: "Keep notes.",
		task: "Say hi.",
		category: "Agents-Life",
	});
const createGroup045 = (ops: AgentOps) =>
	ops.createGroup({
		name: "pair",
		displayName: "Pair",
		members: ["infra", "doctor"],
		category: "Groups-Work",
	});
const channelOf = (name: string) =>
	fx.store.agent(name)?.channelId ?? fx.store.group(name)?.channelId ?? "";

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("a 0.45 caller of AgentOps on a team with Discord channels", () => {
	useTeamFixture();

	test("create's category reaches the place provider as hints.category", async () => {
		// Discord's provider opens a channel under `hints.category` and reads nothing else for it.
		await duringTurn(() => create045(fx.team));
		await settle();
		expect(fx.channels.categoryOf(channelOf("notes"))).toBe("Agents-Life");
	});

	test("createGroup's category reaches the place provider as hints.category", async () => {
		await createGroup045(fx.team);
		expect(fx.channels.categoryOf(channelOf("pair"))).toBe("Groups-Work");
	});

	test("arrange sorts the channels as channel_arrange does", async () => {
		expect(await arrange045(fx.team)).toStartWith("Arranged the channels.");
		expect(fx.channels.categoryOf(channelOf("doctor"))).toBe("Agents-Work");
	});

	test("read gives a channel's messages as channel_read does", async () => {
		const doctor = channelOf("doctor");
		expect(await read045(fx.team, `<#${doctor}>`)).toBe(
			`<#${doctor}> has no messages there.`,
		);
		await expect(read045(fx.team, "the doctor")).rejects.toThrow(
			"Give the channel as <#id> or its id",
		);
	});
});

describeDb("a 0.45 caller of AgentOps on a team without Discord", () => {
	useTeamFixture({ local: true });

	test("arrange and read refuse in the words 0.45 gave", async () => {
		const refusal =
			"This host has no Discord channels: the agents live in rooms of a chat surface, so there is nothing to arrange or read here.";
		await expect(arrange045(fx.team)).rejects.toThrow(refusal);
		await expect(read045(fx.team, "<#1>")).rejects.toThrow(refusal);
	});
});
