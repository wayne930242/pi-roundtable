import { expect, test } from "bun:test";
import { PluginError } from "../errors.ts";
import { channelKey, parseChannelKey } from "./surface.ts";

test("a key splits at its first colon and rebuilds", () => {
	expect(parseChannelKey("discord:123")).toEqual({
		surface: "discord",
		id: "123",
	});
	// An id may hold colons of its own.
	expect(parseChannelKey("mcp:a:b")).toEqual({ surface: "mcp", id: "a:b" });
	expect(channelKey("fake", "9")).toBe("fake:9");
	expect(parseChannelKey(channelKey("fake", "a:b"))).toEqual({
		surface: "fake",
		id: "a:b",
	});
});

test("a key without a surface, or a surface with a colon, is refused", () => {
	expect(() => parseChannelKey(":123")).toThrow(PluginError);
	expect(() => parseChannelKey("nocolon" as never)).toThrow(
		/not a channel key/,
	);
	expect(() => channelKey("", "1")).toThrow(PluginError);
	expect(() => channelKey("a:b", "1")).toThrow(/not a surface name/);
});
