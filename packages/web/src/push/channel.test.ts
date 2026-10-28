import { expect, test } from "bun:test";
import { webPushChannel } from "./channel.ts";

function channel(home: string | null = "app:agent.guide") {
	const posted: { room: string; text: string }[] = [];
	const pushed: { principalId: string; text: string; room?: string }[] = [];
	const provider = webPushChannel({
		surface: "app",
		identity: { tierOf: async (id) => (id === "ada" ? "owner" : "member") },
		home: () => (home ?? undefined) as never,
		post: async (room, text) => void posted.push({ room, text }),
		push: {
			notice: async (principalId, text, room) =>
				void pushed.push({ principalId, text, ...(room ? { room } : {}) }),
		},
	});
	return { provider, posted, pushed };
}

test("a notice delivered here is written in the home room and pushed", async () => {
	const { provider, posted, pushed } = channel();
	expect(await provider.reaches("ada")).toBe("app:agent.guide");
	await provider.deliver?.("ada", "the build finished");
	expect(posted).toEqual([
		{ room: "app:agent.guide", text: "the build finished" },
	]);
	expect(pushed).toEqual([
		{ principalId: "ada", text: "the build finished", room: "app:agent.guide" },
	]);
});

test("a notice another channel delivered is only pushed, so the phone hears it too", async () => {
	const { provider, posted, pushed } = channel();
	await provider.mirror?.("ada", "the build finished");
	expect(posted).toEqual([]);
	expect(pushed).toHaveLength(1);
});

test("only an owner with a home room is reached here", async () => {
	expect(await channel().provider.reaches("bo")).toBeUndefined();
	expect(await channel(null).provider.reaches("ada")).toBeUndefined();
	expect(await channel().provider.knows?.("bo")).toBe(false);
	await expect(channel().provider.deliver?.("bo", "x")).rejects.toThrow(
		"no room",
	);
});
