import { expect, test } from "bun:test";
import { hostRemote } from "./host-conversation.ts";

test("the host's plugin is a remote-mcp plugin that declares its own migrations", () => {
	const plugin = hostRemote("token", "https://bot.example.test");
	expect(plugin.name).toBe("remote-mcp");
	expect(plugin.migrations?.map((m) => m.name)).toEqual([
		"channel-grants",
		"remote-sessions",
	]);
});
