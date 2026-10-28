import { expect, test } from "bun:test";
import type { Logger } from "pi-roundtable";
import { Presence } from "./presence.ts";
import type { Sockets } from "./sockets.ts";

const silent = {
	warn() {},
	info() {},
	error() {},
	debug() {},
} as unknown as Logger;

test("a socket opened while a change waits does not keep the open sockets from hearing it", async () => {
	let busy = false;
	let changed = () => {};
	const broadcasts: unknown[] = [];
	const presence = new Presence({
		team: {
			status: async () =>
				({
					agents: [{ name: "rev", workingIn: busy ? "discord:1" : undefined }],
				}) as never,
			onChange: (listener: () => void) => {
				changed = listener;
				return () => {};
			},
		},
		sockets: {
			broadcast: (frame: unknown) => broadcasts.push(frame),
		} as unknown as Sockets,
		working: () => new Set(),
		logger: silent,
		coalesceMs: 20,
	});
	busy = true;
	changed();
	// A new socket reads the table before the waiting broadcast fires.
	expect((await presence.frame()).agents.rev?.busy).toBe(true);
	await Bun.sleep(60);
	expect(broadcasts).toEqual([
		{ type: "presence", agents: { rev: { busy: true } } },
	]);
	presence.stop();
});
