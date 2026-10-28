import { expect, test } from "bun:test";
import type { ChannelKey } from "pi-roundtable";
import { AppSurface } from "./surface.ts";

const ROOM = "app:agent.guide" as ChannelKey;

function surfaceAt(clock: { now: number }) {
	const heard: string[] = [];
	const surface = new AppSurface({
		surface: "app",
		sockets: { broadcast: () => undefined },
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
