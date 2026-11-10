import { describe, expect, test } from "bun:test";
import { ChannelToolError, parseChannelTool } from "./channel-operations.ts";

describe("discord_search_messages dates", () => {
	test.each([
		["afterDate", "2026-11-01T00:00:00+08:00[Asia/Taipei]"],
		["beforeDate", "2026-11-01T00:00:00+08:00[Asia/Taipei]"],
	])(
		"an unparsable %s instant is refused as invalid arguments",
		(key, value) => {
			let error: unknown;
			try {
				parseChannelTool("discord_search_messages", {
					channelId: "100000000000000001",
					[key]: value,
				});
			} catch (e) {
				error = e;
			}
			expect(error).toBeInstanceOf(ChannelToolError);
			expect((error as Error).message).toContain("INVALID_CHANNEL_ARGUMENTS");
		},
	);
});
