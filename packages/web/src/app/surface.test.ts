import { expect, test } from "bun:test";
import type { ChannelKey } from "pi-roundtable";
import { AppSurface } from "./surface.ts";

const ROOM = "app:agent.guide" as ChannelKey;

function surfaceAt(clock: { now: number }) {
	const heard: string[] = [];
	const surface = new AppSurface({
		surface: "app",
		sockets: { deliver: () => undefined },
		audienceOf: () => ({ owners: true }),
		isHostRoom: () => false,
		log: { append: async (row: object) => ({ id: 1, ...row }) },
		files: {},
		uploads: { maxBytes: 1 },
		threads: {},
		canHost: async () => false,
		changed: () => undefined,
		unprompted: (_room: string, _author: string, text: string) =>
			void heard.push(text),
		now: () => clock.now,
		logger: { warn: () => undefined },
	} as never);
	return { surface, heard };
}

const reply = (text: string) => ({ chunks: [text] }) as never;

test("a reply to a page's message is not unprompted; a turn long after one is", async () => {
	const clock = { now: 1_000_000 };
	const { surface, heard } = surfaceAt(clock);
	await surface.start(() => undefined);
	surface.deliver({ channel: ROOM } as never);
	const stop = surface.startTyping(ROOM);
	await surface.sendReply(ROOM, reply("asked"));
	stop();
	expect(heard).toEqual([]);
	// A scheduled turn well past the window is no answer to the page's message.
	clock.now += 31_000;
	const later = surface.startTyping(ROOM);
	await surface.sendReply(ROOM, reply("scheduled"));
	later();
	expect(heard).toEqual(["scheduled"]);
});

test("a message between agents is stored as its card with its whole text, ends no turn and notifies nobody", async () => {
	const rows: Record<string, unknown>[] = [];
	const frames: { type: string; outcome?: string }[] = [];
	const surface = new AppSurface({
		surface: "app",
		sockets: {
			deliver: (frame: { type: string; outcome?: string }) =>
				void frames.push(frame),
		},
		audienceOf: () => ({ owners: true }),
		isHostRoom: () => false,
		log: {
			append: async (row: Record<string, unknown>) => {
				rows.push(row);
				return { id: rows.length, ...row };
			},
		},
		files: {},
		uploads: { maxBytes: 1 },
		threads: {},
		canHost: async () => false,
		changed: () => undefined,
		unprompted: () => {
			throw new Error("a card notifies nobody");
		},
		now: () => 1_000_000,
		logger: { warn: () => undefined },
	} as never);
	await surface.start(() => undefined);
	const stop = surface.startTyping(ROOM);
	await surface.sendReply(ROOM, {
		chunks: ["→ To **Scout**", "check the disk"],
		author: { name: "Guide", agent: "guide" },
		intercom: {
			kind: "sent",
			peer: { name: "scout", displayName: "Scout" },
			text: "check the disk",
		},
	});
	expect(rows).toEqual([
		{
			room: ROOM,
			kind: "agent",
			agent: "guide",
			author: "Guide",
			text: "check the disk",
			intercom: { kind: "sent", peer: { name: "scout", displayName: "Scout" } },
		},
	]);
	stop();
	// The turn that was typing ends without a reply's outcome: the card was none.
	expect(frames.some((frame) => frame.outcome !== undefined)).toBe(false);
});

test("a room's interim posts leave the tools to the progress pane", () => {
	const { surface } = surfaceAt({ now: 0 });
	expect(surface.interim(ROOM).tools).toBe(false);
});

test("a room's old page message is forgotten when another room is asked", async () => {
	const clock = { now: 1_000_000 };
	const { surface, heard } = surfaceAt(clock);
	await surface.start(() => undefined);
	surface.deliver({ channel: ROOM } as never);
	clock.now += 60_000;
	surface.deliver({ channel: "app:agent.other" } as never);
	// Still unprompted: the old note is past the window whether or not it was pruned.
	const stop = surface.startTyping(ROOM);
	await surface.sendReply(ROOM, reply("late"));
	stop();
	expect(heard).toEqual(["late"]);
});

test("a file an agent attaches in a host room is bound to it, with the kind's expiry", async () => {
	const puts: unknown[][] = [];
	const surface = new AppSurface({
		surface: "app",
		sockets: { deliver: () => undefined },
		audienceOf: () => ({ room: "x" }),
		isHostRoom: (room: string) => room === "app:inbox.1",
		fileBinding: (room: string) => ({ room, expiresAt: 42 }),
		log: { append: async (row: object) => ({ id: 1, ...row }) },
		files: {
			put: (...args: unknown[]) => {
				puts.push(args);
				return { id: "f", name: "a.txt", type: "text/plain", size: 1 };
			},
		},
		uploads: { maxBytes: 1 },
		threads: {},
		canHost: async () => false,
		changed: () => undefined,
		logger: { warn: () => undefined },
	} as never);
	await surface.start(() => undefined);
	const file = { name: "a.txt", data: new Uint8Array([1]) };
	await surface.sendReply(
		"app:inbox.1" as ChannelKey,
		{
			chunks: ["x"],
			files: [file],
		} as never,
	);
	await surface.sendReply(ROOM, { chunks: ["x"], files: [file] } as never);
	expect(puts[0]?.[4]).toEqual({ room: "app:inbox.1", expiresAt: 42 });
	expect(puts[1]?.[4]).toBeUndefined();
});

const GROUP = "app:group.crew" as ChannelKey;

test("a group round reaches the room's audience as a frame, a page that opens mid-round reads it, and an ended round leaves no snapshot", () => {
	const frames: { frame: unknown; audience: unknown }[] = [];
	const surface = new AppSurface({
		surface: "app",
		sockets: {
			deliver: (frame: unknown, audience: unknown) =>
				void frames.push({ frame, audience }),
		},
		audienceOf: () => ({ owners: true }),
		isHostRoom: () => false,
		log: { append: async (row: object) => ({ id: 1, ...row }) },
		files: {},
		uploads: { maxBytes: 1 },
		threads: {},
		canHost: async () => false,
		changed: () => undefined,
		logger: { warn: () => undefined },
	} as never);
	const running = {
		id: 7,
		state: "running" as const,
		current: "scout",
		next: ["mason"],
		spoken: [],
		replies: 0,
		limit: 8,
	};
	surface.groupRound(GROUP, running);
	expect(frames).toEqual([
		{
			frame: { type: "round", room: GROUP, round: running },
			audience: { owners: true },
		},
	]);
	expect(surface.roundOf(GROUP)).toEqual(running);
	expect(surface.roundOf(ROOM)).toBeUndefined();
	const ended = {
		...running,
		state: "ended" as const,
		ended: "done" as const,
		next: [],
		spoken: ["scout", "mason"],
		replies: 2,
	};
	delete (ended as { current?: string }).current;
	surface.groupRound(GROUP, ended);
	expect(frames.at(-1)?.frame).toEqual({
		type: "round",
		room: GROUP,
		round: ended,
	});
	// The page keeps what it was told; a page that opens afterwards finds no round running.
	expect(surface.roundOf(GROUP)).toBeUndefined();
});
