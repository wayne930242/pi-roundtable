import { expect, test } from "bun:test";
import { discordIdOf, discordKey } from "../contract/discord-key.ts";
import type { PlaceProvider } from "../contract/places.ts";
import {
	discordTestPlaces,
	legacyRows,
	testPlaces,
} from "../testing/team-places.ts";
import type { StoredPlace } from "./agent-places.ts";
import type { Agent, AgentGroup } from "./agent-store.ts";
import {
	agentRoomKey,
	coordinatorOf,
	groupRoomKey,
	roomOf,
} from "./team-keys.ts";

const AGENT = {
	name: "coder",
	displayName: "Coder",
	status: "active",
	channelId: "1234567890",
} as Agent;
const ARCHIVED = {
	name: "old",
	displayName: "Old",
	status: "archived",
	channelId: "777",
} as Agent;
const ROOMER = {
	name: "roomer",
	displayName: "Roomer",
	status: "active",
} as Agent;
const GROUP = {
	name: "ops",
	channelId: "555",
	status: "active",
	members: ["coder"],
	host: "coder",
} as AgentGroup;
const ROOM_GROUP = { name: "crew", status: "active" } as AgentGroup;

const AGENTS = [AGENT, ARCHIVED, ROOMER];
const GROUPS = [GROUP, ROOM_GROUP];
const store = {
	agent: (name: string) => AGENTS.find((a) => a.name === name),
	group: (name: string) => GROUPS.find((g) => g.name === name),
};

/** A host with Discord's agent channels and the rooms of `app`: the places of the three agents and two groups above. */
const places = (rows: readonly StoredPlace[] = legacyRows(AGENTS, GROUPS)) =>
	testPlaces({ store, rows: () => rows, rooms: () => ["app"] });

// ── What a Discord team's keys were before places were providers (0.43) ───

test("a Discord team's keys, seats and log names are what they were in 0.43", () => {
	const host = places();
	// Keys: the Discord channel first, then each room.
	expect(host.keysOf("coder")).toEqual([
		"discord:1234567890",
		"app:agent.coder",
	]);
	expect(host.keysOf("ops")).toEqual(["discord:555", "app:group.ops"]);
	expect(host.keysOf("roomer")).toEqual(["app:agent.roomer"]);
	expect(host.keysOf("nobody")).toEqual([]);
	// Seats: `agentgroup:<channel id>.<agent>` in the channel, the surface-qualified room form in a room.
	expect(host.seatKey(GROUP, "coder")).toBe("agentgroup:555.coder");
	expect(host.seatKey(GROUP, "coder", discordKey("555"))).toBe(
		"agentgroup:555.coder",
	);
	expect(host.seatKey(GROUP, "coder", groupRoomKey("app", "ops"))).toBe(
		"agentgroup:app.group.ops.coder",
	);
	expect(host.seatsOf(GROUP, "coder")).toEqual([
		"agentgroup:555.coder",
		"agentgroup:app.group.ops.coder",
	]);
	// Log names: the group's own in its channel, `<group>@<surface>` in a room.
	expect(host.logName(GROUP, discordKey("555"))).toBe("ops");
	expect(host.logName(GROUP, groupRoomKey("app", "ops"))).toBe("ops@app");
	// Scopes: an agent's own conversation in its channel or its room, and its seat in a group.
	expect(host.scopeOf(AGENT, discordKey("1234567890"))).toEqual({
		name: "coder",
		session: "discord:1234567890",
		home: "discord:1234567890",
	});
	expect(host.scopeOf(AGENT, "app:agent.coder")).toEqual({
		name: "coder",
		session: "app:agent.coder",
		home: "app:agent.coder",
	});
	expect(host.groupScope(AGENT, GROUP)).toEqual({
		name: "coder",
		session: "agentgroup:555.coder",
		home: "discord:1234567890",
		group: "ops",
	});
	expect(host.groupScope(AGENT, GROUP, groupRoomKey("app", "ops"))).toEqual({
		name: "coder",
		session: "agentgroup:app.group.ops.coder",
		home: "app:agent.coder",
		group: "ops",
	});
	// A seat outside its turn posts in the group's place on the surface of its home.
	expect(host.seatChannel(GROUP, { home: "discord:1234567890" })).toBe(
		"discord:555",
	);
	expect(host.seatChannel(GROUP, { home: "app:agent.coder" })).toBe(
		"app:group.ops",
	);
	expect(host.seatChannel(ROOM_GROUP, { home: "discord:1234567890" })).toBe(
		"discord:1234567890",
	);
});

test("a group of a team without Discord has no seat of its own to key", () => {
	const host = places();
	expect(() => host.seatKey(ROOM_GROUP, "coder")).toThrow(
		"the group crew has no place of its own",
	);
	expect(host.seatKey(ROOM_GROUP, "coder", groupRoomKey("app", "crew"))).toBe(
		"agentgroup:app.group.crew.coder",
	);
});

// ── Who owns a key ───────────────────────────────────────────────────────

test("an agent or a group owns the Discord key of its channel while active", () => {
	const host = places();
	expect(host.ownerKind(discordKey("1234567890"))).toBe("agent");
	expect(host.ownerKind(discordKey("555"))).toBe("group");
	expect(host.ownerKind(discordKey("999"))).toBeUndefined();
	// An archived agent keeps its channel under Archive, and owns nothing there.
	expect(host.ownerKind(discordKey("777"))).toBeUndefined();
	expect(host.agentOf(discordKey("777"))).toBeUndefined();
	expect(host.agentOf(discordKey("1234567890"))).toBe(AGENT);
	expect(host.groupOf(discordKey("555"))).toBe(GROUP);
	expect(host.ownerOf(discordKey("555"))).toEqual({
		kind: "group",
		name: "ops",
		stored: true,
	});
});

test("a key of another surface whose id equals an agent's channel id is not the agent's", () => {
	const host = places();
	expect(host.ownerKind("mcp:1234567890")).toBeUndefined();
	expect(host.ownerKind("fake:1234567890")).toBeUndefined();
	expect(host.ownerKind("webhook:555")).toBeUndefined();
	// The old slice took "?" and "1234567890" from a key of the same length as `discord:`.
	expect(host.ownerKind("matrix:x1234567890")).toBeUndefined();
});

test("a Discord key is nobody's on a host with no Discord provider, whatever rows are stored", () => {
	const host = testPlaces({
		store,
		rows: () => legacyRows(AGENTS, GROUPS),
		rooms: () => ["app"],
		discord: false,
	});
	expect(host.ownerKind(discordKey("1234567890"))).toBeUndefined();
	expect(host.keysOf("coder")).toEqual(["app:agent.coder"]);
	expect(host.placeOn("coder", "discord")).toBeUndefined();
});

test("a stale key of a surface no provider serves is not a room: a seat posts where its home is, and the scope never builds a room from it", () => {
	const bare = testPlaces({
		store,
		rows: () => legacyRows(AGENTS, GROUPS),
		rooms: () => ["app"],
		discord: false,
	});
	const stale = discordKey("1234567890");
	// 0.44: a Discord seat's home was its channel, whatever else the host had.
	expect(bare.seatChannel(GROUP, { home: stale })).toBe(stale);
	expect(bare.seatChannel(ROOM_GROUP, { home: stale })).toBe(stale);
	expect(bare.scopeOf(AGENT, stale).home).toBe(stale);
	// Another stored surface's place of the agent is its own place, not a room of the stale key's surface.
	const chat: PlaceProvider = {
		surface: "chat",
		storage: "stored",
		key: (_ref, id) => `chat:${id}`,
		placeOf: (key) =>
			key.startsWith("chat:") ? { id: key.slice(5) } : undefined,
		post: async () => undefined,
	};
	const withChat = testPlaces({
		store,
		rows: () => [
			{ kind: "agent", name: "coder", surface: "chat", externalId: "c1" },
		],
		rooms: () => ["app"],
		discord: false,
		stored: () => [chat],
	});
	expect(withChat.scopeOf(AGENT, stale)).toEqual({
		name: "coder",
		session: "chat:c1",
		home: "chat:c1",
	});
	// A key of a surface that hosts rooms is still a room.
	expect(withChat.seatChannel(ROOM_GROUP, { home: "app:agent.coder" })).toBe(
		"app:group.crew",
	);
});

test("discordIdOf reads only Discord keys", () => {
	expect(discordIdOf(discordKey("42"))).toBe("42");
	expect(discordIdOf("mcp:42")).toBeUndefined();
});

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
});

test("an agent or group owns its room only on a room surface, and only while active", () => {
	const host = places();
	expect(host.ownerKind("app:agent.coder")).toBe("agent");
	expect(host.ownerKind("app:group.ops")).toBe("group");
	expect(host.ownerKind("app:agent.nobody")).toBeUndefined();
	expect(host.ownerKind("app:agent.old")).toBeUndefined();
	// A room names an archived agent, so what it left behind can be found.
	expect(host.agentOf("app:agent.old")).toBe(ARCHIVED);
	expect(host.ownerKind("other:agent.coder")).toBeUndefined();
	// A group name is not an agent's room.
	expect(host.ownerKind("app:agent.ops")).toBeUndefined();
	// A surface that hosts no rooms has none.
	const none = testPlaces({ store, rooms: () => [], discord: false });
	expect(none.ownerKind("app:agent.coder")).toBeUndefined();
});

test("a room is its own conversation: session, home and group seats are keyed by the room", () => {
	const host = places();
	const room = agentRoomKey("app", "coder");
	expect(host.scopeOf(AGENT, room)).toEqual({
		name: "coder",
		session: "app:agent.coder",
		home: "app:agent.coder",
	});
	const group = groupRoomKey("app", "ops");
	expect(host.seatKey(GROUP, "coder", group)).toBe(
		"agentgroup:app.group.ops.coder",
	);
	// Without a room, or in a Discord channel, the key is the Discord group's as before.
	expect(host.seatKey(GROUP, "coder")).toBe("agentgroup:555.coder");
	expect(host.seatKey(GROUP, "coder", discordKey("555"))).toBe(
		"agentgroup:555.coder",
	);
	expect(host.groupScope(AGENT, GROUP, group)).toEqual({
		name: "coder",
		session: "agentgroup:app.group.ops.coder",
		home: "app:agent.coder",
		group: "ops",
	});
	expect(host.logName(GROUP, group)).toBe("ops@app");
	expect(host.logName(GROUP, discordKey("555"))).toBe("ops");
});

// ── The coordinator ──────────────────────────────────────────────────────

test("the coordinator is the entry channel's agent with Discord, else the configured one", () => {
	const host = places();
	expect(
		coordinatorOf(store, host, { entryChannel: discordKey("1234567890") }),
	).toBe(AGENT);
	expect(
		coordinatorOf(store, host, { entryChannel: discordKey("777") }),
	).toBeUndefined();
	expect(coordinatorOf(store, host, { coordinator: "roomer" })).toBe(ROOMER);
	expect(
		coordinatorOf(store, host, { coordinator: () => "old" }),
	).toBeUndefined();
});

test("a provider that names the coordinator's place makes its agent the coordinator, and the configured one is not asked", () => {
	const host = testPlaces({
		store,
		rows: () => legacyRows(AGENTS, GROUPS),
		discord: false,
		stored: () => [{ ...discordTestPlaces(), coordinatorPlace: "1234567890" }],
	});
	expect(host.entry()).toBe("discord:1234567890");
	expect(coordinatorOf(store, host, { coordinator: "roomer" })).toBe(AGENT);
	expect(places().entry()).toBeUndefined();
});
