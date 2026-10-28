import { expect, test } from "bun:test";
import type { Agent, AgentGroup } from "./agent-store.ts";
import {
	agentRoomKey,
	channelOwner,
	discordIdOf,
	discordKey,
	groupLogName,
	groupRoomKey,
	groupScope,
	groupSessionKey,
	roomOf,
	roomScope,
} from "./team-keys.ts";

const store = {
	agentByChannel: (id: string) =>
		id === "1234567890" ? ({} as never) : undefined,
	groupByChannel: (id: string) => (id === "555" ? ({} as never) : undefined),
};

test("an agent or a group owns the Discord key of its channel", () => {
	expect(channelOwner(store, discordKey("1234567890"))).toBe("agent");
	expect(channelOwner(store, discordKey("555"))).toBe("group");
	expect(channelOwner(store, discordKey("777"))).toBeUndefined();
});

test("a key of another surface whose id equals an agent's channel id is not the agent's", () => {
	expect(channelOwner(store, "mcp:1234567890")).toBeUndefined();
	expect(channelOwner(store, "fake:1234567890")).toBeUndefined();
	expect(channelOwner(store, "webhook:555")).toBeUndefined();
	// The old slice took "?" and "1234567890" from a key of the same length as `discord:`.
	expect(channelOwner(store, "matrix:x1234567890")).toBeUndefined();
});

test("discordIdOf reads only Discord keys", () => {
	expect(discordIdOf(discordKey("42"))).toBe("42");
	expect(discordIdOf("mcp:42")).toBeUndefined();
});

const AGENT = { name: "coder", status: "active" } as Agent;
const GROUP = {
	name: "ops",
	channelId: "555",
	status: "active",
} as AgentGroup;

const roomStore = {
	...store,
	agent: (name: string) =>
		name === "coder"
			? AGENT
			: name === "old"
				? ({ name, status: "archived" } as Agent)
				: undefined,
	group: (name: string) => (name === "ops" ? GROUP : undefined),
};

test("room keys name the surface, the kind and the agent or group", () => {
	expect(agentRoomKey("app", "coder")).toBe("app:agent.coder");
	expect(groupRoomKey("app", "ops")).toBe("app:group.ops");
	expect(roomOf("app:agent.coder", ["app"])).toEqual({
		kind: "agent",
		name: "coder",
	});
	expect(roomOf("app:group.ops", ["app"])).toEqual({
		kind: "group",
		name: "ops",
	});
});

test("roomOf reads only keys of a surface that hosts rooms, in the exact shape", () => {
	expect(roomOf("other:agent.coder", ["app"])).toBeUndefined();
	expect(roomOf("app:thread.1234", ["app"])).toBeUndefined();
	expect(roomOf("app:agent.", ["app"])).toBeUndefined();
	expect(roomOf("app:agent.Coder", ["app"])).toBeUndefined();
	expect(roomOf("app:agent.a.b", ["app"])).toBeUndefined();
	expect(roomOf("app:agent.coder:x", ["app"])).toBeUndefined();
	expect(roomOf("app:agent.coder", [])).toBeUndefined();
	// Discord never hosts rooms, whatever a surface list says.
	expect(roomOf("discord:agent.coder", ["discord"])).toBeUndefined();
});

test("an agent or group owns its room only on a room surface, and only while active", () => {
	expect(channelOwner(roomStore, "app:agent.coder", ["app"])).toBe("agent");
	expect(channelOwner(roomStore, "app:group.ops", ["app"])).toBe("group");
	expect(channelOwner(roomStore, "app:agent.nobody", ["app"])).toBeUndefined();
	expect(channelOwner(roomStore, "app:agent.old", ["app"])).toBeUndefined();
	expect(channelOwner(roomStore, "other:agent.coder", ["app"])).toBeUndefined();
	expect(channelOwner(roomStore, "app:agent.coder")).toBeUndefined();
	// A group name is not an agent's room.
	expect(channelOwner(roomStore, "app:agent.ops", ["app"])).toBeUndefined();
});

test("a room is its own conversation: session, home and group seats are keyed by the room", () => {
	const room = agentRoomKey("app", "coder");
	expect(roomScope(AGENT, room)).toEqual({
		name: "coder",
		session: "app:agent.coder",
		home: "app:agent.coder",
	});
	const group = groupRoomKey("app", "ops");
	expect(groupSessionKey(GROUP, "coder", group)).toBe(
		"agentgroup:app.group.ops.coder",
	);
	// Without a room, or in a Discord channel, the key is the Discord group's as before.
	expect(groupSessionKey(GROUP, "coder")).toBe("agentgroup:555.coder");
	expect(groupSessionKey(GROUP, "coder", discordKey("555"))).toBe(
		"agentgroup:555.coder",
	);
	expect(groupScope(AGENT, GROUP, group)).toEqual({
		name: "coder",
		session: "agentgroup:app.group.ops.coder",
		home: "app:agent.coder",
		group: "ops",
	});
	expect(groupLogName(GROUP, group)).toBe("ops@app");
	expect(groupLogName(GROUP, discordKey("555"))).toBe("ops");
});
