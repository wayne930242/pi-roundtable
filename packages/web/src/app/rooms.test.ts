import { expect, test } from "bun:test";
import type { Agent, ChannelKey } from "pi-roundtable";
import { Rooms, roomModeOf } from "./rooms.ts";

const agent = (name: string, status: Agent["status"] = "active"): Agent => ({
	name,
	displayName: name,
	prompt: `You are ${name}.`,
	avatarPrompt: "",
	status,
});

function rooms(
	agents: Agent[],
	coordinator: string | undefined,
	last: Map<string, unknown> = new Map(),
) {
	return new Rooms({
		surface: "app",
		mount: "/console",
		directory: {
			agents: () => agents,
			agent: (name) => agents.find((one) => one.name === name),
			groups: () => [],
			group: () => undefined,
		},
		team: { coordinator: () => coordinator },
		avatars: { url: () => "/avatars/x.png" },
		threads: { get: async () => undefined, list: async () => [] },
		log: {
			lastOf: async (keys: readonly string[]) =>
				new Map(
					keys.flatMap((key) =>
						last.has(key) ? [[key, last.get(key)] as const] : [],
					),
				) as never,
		},
		modes: { peek: () => ({ yolo: false, longRunning: false }) },
		mutes: { all: async () => new Set() },
		activity: () => ({ typing: false, stoppable: false }),
	});
}

test("the coordinator's room says so, and no other room does", async () => {
	const listed = await rooms(
		[agent("scout"), agent("boss"), agent("infra")],
		"boss",
	).list();
	expect(
		listed.map((room) => [room.name, room.home, room.coordinator]),
	).toEqual([
		["boss", true, true],
		["scout", false, undefined],
		["infra", false, undefined],
	]);
});

test("with no coordinator the first active agent is home, but nobody is the coordinator", async () => {
	const listed = await rooms(
		[agent("old", "archived"), agent("scout")],
		undefined,
	).list();
	expect(
		listed.map((room) => [room.name, room.home, room.coordinator]),
	).toEqual([["scout", true, undefined]]);
});

test("a room shows an inherited mode with the name of where it comes from, or its key without one", () => {
	expect(roomModeOf({ yolo: true, longRunning: false })).toEqual({
		yolo: true,
		longRunning: false,
	});
	expect(
		roomModeOf({
			yolo: true,
			longRunning: true,
			inheritedFrom: {
				channel: "app:agent.infra" as ChannelKey,
				name: "Infra",
			},
		}),
	).toEqual({ yolo: true, longRunning: true, inheritedFrom: "Infra" });
	expect(
		roomModeOf({
			yolo: false,
			longRunning: false,
			inheritedFrom: { channel: "app:agent.infra" as ChannelKey, gone: true },
		}),
	).toEqual({
		yolo: false,
		longRunning: false,
		inheritedFrom: "app:agent.infra",
	});
});

const helper = (name: string, origin: string): Agent => ({
	...agent(name),
	parent: "boss",
	origin,
});

test("a temp knight made on Discord shows here once its room has a message", async () => {
	const team = [
		agent("boss"),
		helper("boss-1", "discord:1000"),
		helper("boss-2", "app:agent.boss"),
		{ ...agent("boss-3"), parent: "boss" },
	];
	const names = async (last?: Map<string, unknown>) =>
		(await rooms(team, "boss", last).list()).map((room) => room.name);
	// The web-born one and one made before the origin was kept show as before.
	expect(await names()).toEqual(["boss", "boss-2", "boss-3"]);
	expect(
		await names(new Map([["app:agent.boss-1", { id: 1, text: "hi" }]])),
	).toEqual(["boss", "boss-1", "boss-2", "boss-3"]);
});

test("a temp knight made on Discord shows here once it is opened by its address", async () => {
	const directory = rooms(
		[agent("boss"), helper("boss-1", "discord:1000")],
		"boss",
	);
	expect((await directory.list()).map((room) => room.name)).toEqual(["boss"]);
	const opened = await directory.openHelper("app:agent.boss-1" as ChannelKey);
	expect(opened?.helper?.parent).toBe("app:agent.boss");
	expect((await directory.list()).map((room) => room.name)).toEqual([
		"boss",
		"boss-1",
	]);
	// No other room opens this way.
	expect(
		await directory.openHelper("app:agent.boss" as ChannelKey),
	).toBeUndefined();
});
