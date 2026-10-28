import { describe, expect, test } from "bun:test";
import type { ChannelKey } from "../domain/conversation.ts";
import {
	type DirectChannelProvider,
	directChannelsPort,
} from "./direct-channels.ts";

function inbox(
	name: string,
	reached: Record<string, ChannelKey>,
	delivered?: { name: string; principalId: string; text: string }[],
): DirectChannelProvider {
	return {
		name,
		label: `a notice in ${name}`,
		reaches: async (principalId) => reached[principalId],
		...(delivered
			? {
					deliver: async (principalId: string, text: string) =>
						void delivered.push({ name, principalId, text }),
				}
			: {}),
	};
}

describe("the direct channels", () => {
	test("reach a person through the first provider, in contribution order, that reaches them", async () => {
		const first = inbox("first", { ada: "first:ada" });
		const second = inbox("second", { ada: "second:ada", bo: "second:bo" });
		const port = directChannelsPort(() => [first, second], {
			sendReply: async () => undefined,
		});
		expect(port.providers()).toEqual([first, second]);
		expect(await port.reach("ada")).toEqual({
			provider: first,
			channel: "first:ada",
		});
		expect((await port.reach("bo"))?.channel).toBe("second:bo");
		expect(await port.reach("kai")).toBeUndefined();
	});

	test("know a person by the first provider that knows them without the network, or else that reaches them", async () => {
		const offline: DirectChannelProvider = {
			...inbox("offline", {}),
			knows: async (principalId) => principalId === "ada",
			reaches: async () => {
				throw new Error("unreachable");
			},
		};
		const second = inbox("second", { bo: "second:bo" });
		const port = directChannelsPort(() => [offline, second], {
			sendReply: async () => undefined,
		});
		expect(await port.known("ada")).toBe(offline);
		expect(await port.known("bo")).toBe(second);
		expect(await port.known("kai")).toBeUndefined();
	});

	test("notify through the provider's own delivery, or else posts in the channel it reaches; false for someone none reaches", async () => {
		const delivered: { name: string; principalId: string; text: string }[] = [];
		const posted: { channel: ChannelKey; chunks: string[] }[] = [];
		const port = directChannelsPort(
			() => [
				inbox("own", { ada: "own:ada" }, delivered),
				inbox("posted", { bo: "posted:bo" }),
			],
			{
				sendReply: async (channel, reply) =>
					void posted.push({ channel, chunks: [...reply.chunks] }),
			},
		);
		expect(await port.notify("ada", "one")).toBe(true);
		expect(await port.notify("bo", "two")).toBe(true);
		expect(await port.notify("kai", "three")).toBe(false);
		expect(delivered).toEqual([
			{ name: "own", principalId: "ada", text: "one" },
		]);
		expect(posted).toEqual([{ channel: "posted:bo", chunks: ["two"] }]);
	});

	test("mirror a delivered notice to every other provider once, and never let a mirror change the result", async () => {
		const mirrored: { name: string; principalId: string; text: string }[] = [];
		const warned: unknown[] = [];
		const mirroring = (name: string): DirectChannelProvider => ({
			...inbox(name, { ada: `${name}:ada` }, []),
			mirror: async (principalId, text) =>
				void mirrored.push({ name, principalId, text }),
		});
		const a = mirroring("a");
		const b = mirroring("b");
		const broken: DirectChannelProvider = {
			...inbox("broken", {}),
			mirror: async () => {
				throw new Error("push service is down");
			},
		};
		const port = directChannelsPort(
			() => [a, b, broken],
			{ sendReply: async () => undefined },
			{ warn: (...args: unknown[]) => void warned.push(args) },
		);
		expect(await port.notify("ada", "ping")).toBe(true);
		// A delivered, so only B is mirrored (A is not echoed its own delivery); the rejecting mirror is only logged.
		expect(mirrored).toEqual([{ name: "b", principalId: "ada", text: "ping" }]);
		expect(warned).toHaveLength(1);
		// Nobody reached: nothing delivered, nothing mirrored.
		mirrored.length = 0;
		expect(await port.notify("kai", "ping")).toBe(false);
		expect(mirrored).toEqual([]);
	});
});
