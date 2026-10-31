import { expect, test } from "bun:test";
import { partial } from "pi-roundtable/testing";
import type { RoomMessage } from "../api-types.ts";
import type { Answerer } from "./desk.ts";
import { changeQueued, type QueuedFrameDeps } from "./queued-frames.ts";

const ROOM = "app:agent.scout";
const ada = partial<Answerer>({ principalId: "ada", tier: "owner" });
const stored = partial<RoomMessage>({
	id: 5,
	kind: "owner",
	principalId: "ada",
	files: [],
});

/** Deps whose log write of the first text is slower than the second's, as two sockets' updates can be. */
function slowFirst(failOn?: string) {
	const core: string[] = [];
	const log: string[] = [];
	const deps = partial<QueuedFrameDeps>({
		rooms: { resolve: async (key) => ({ key, readOnly: false }) as never },
		surface: {
			delivery: { stored: async () => stored } as never,
			edit: async (_room: string, _id: number, text: string) => {
				await new Promise((resolve) =>
					setTimeout(resolve, text === "A" ? 30 : 0),
				);
				if (text === failOn) throw new Error("log down");
				log.push(text);
				return undefined as never;
			},
		},
		conversations: {
			editQueued: (_room: string, _id: string, _by: unknown, text: string) => {
				core.push(text);
				return "done" as const;
			},
		},
	});
	return { core, log, deps };
}

const edit = (text: string) =>
	({ type: "edit_queued", room: ROOM, message: 5, text }) as const;

test("two edits of one room reach the log in the order the host took them, so the last wins", async () => {
	const { core, log, deps } = slowFirst();
	const results = await Promise.all([
		changeQueued(edit("A"), ada, deps),
		changeQueued(edit("B"), ada, deps),
	]);
	expect(results).toEqual([undefined, undefined]);
	expect(core).toEqual(["A", "B"]);
	expect(log).toEqual(["A", "B"]);
});

test("a change that fails does not hold back the ones after it", async () => {
	const { log, deps } = slowFirst("A");
	const first = changeQueued(edit("A"), ada, deps);
	const second = changeQueued(edit("B"), ada, deps);
	await expect(first).rejects.toThrow("log down");
	expect(await second).toBeUndefined();
	expect(log).toEqual(["B"]);
});
