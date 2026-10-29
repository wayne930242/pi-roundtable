import { expect, test } from "bun:test";
import { roomMuted } from "./mutes.ts";

const PREFIX = "app:thread.";
const muted = new Set(["app:agent.guide"]);
const check = roomMuted(
	{ has: async (room) => muted.has(room) },
	{
		get: async (id) =>
			id === "thread.under-guide"
				? { parent: "app:agent.guide" }
				: id === "thread.under-scout"
					? { parent: "app:agent.scout" }
					: undefined,
	},
	PREFIX,
);

test("a room follows its own mute", async () => {
	expect(await check("app:agent.guide")).toBe(true);
	expect(await check("app:agent.scout")).toBe(false);
});

test("a thread follows the mute of the room it was opened under", async () => {
	expect(await check("app:thread.under-guide")).toBe(true);
	expect(await check("app:thread.under-scout")).toBe(false);
	expect(await check("app:thread.unknown")).toBe(false);
});
