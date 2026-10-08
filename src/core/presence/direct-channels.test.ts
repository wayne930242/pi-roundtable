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
});
