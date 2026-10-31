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

function rooms(agents: Agent[], coordinator: string | undefined) {
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
		log: { lastOf: async () => new Map() },
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
