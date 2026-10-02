import { expect, test } from "bun:test";
import type { ChatSurface } from "../contract/surface.ts";
import { PluginError } from "../errors.ts";
import { surfacePort } from "./surface-port.ts";

/** A surface that records every call; `with` gives it only some of the optional methods. */
function recording(prefix: string, log: string[], only?: readonly string[]) {
	const surface: ChatSurface = {
		surface: prefix,
		start: async () => undefined,
		sendReply: async (channel) => void log.push(`${prefix} reply ${channel}`),
		startTyping: (channel) => {
			log.push(`${prefix} typing ${channel}`);
			return () => void log.push(`${prefix} typing done`);
		},
		showStop: (channel) => {
			log.push(`${prefix} stop ${channel}`);
			return () => void log.push(`${prefix} stop hidden`);
		},
		react: async (channel, id, emoji) =>
			void log.push(`${prefix} +${emoji} ${id} ${channel}`),
		unreact: async (channel, id, emoji) =>
			void log.push(`${prefix} -${emoji} ${id} ${channel}`),
		prompts: () => ({
			confirm: async () => "approved",
			ask: async () => undefined,
		}),
	};
	if (!only) return surface;
	return Object.fromEntries(
		Object.entries(surface).filter(
			([key]) =>
				["surface", "start", "sendReply"].includes(key) || only.includes(key),
		),
	) as unknown as ChatSurface;
}

test("every call goes to the surface whose prefix starts the key, and to no other", async () => {
	const log: string[] = [];
	const port = surfacePort(() => [recording("a", log), recording("b", log)]);
	await port.sendReply("b:1", { chunks: [] });
	port.startTyping("a:1")();
	port.showStop("b:2")();
	await port.react("a:1", "m", "🙂");
	await port.unreact("b:1", "m", "🙂");
	expect(log).toEqual([
		"b reply b:1",
		"a typing a:1",
		"a typing done",
		"b stop b:2",
		"b stop hidden",
		"a +🙂 m a:1",
		"b -🙂 m b:1",
	]);
	expect(await port.prompts("a:1")?.confirm("t", "m")).toBe("approved");
});

test("an id with colons or the same text as another prefix does not confuse the prefix", async () => {
	const log: string[] = [];
	const port = surfacePort(() => [recording("a", log), recording("ab", log)]);
	await port.sendReply("ab:a:1", { chunks: [] });
	expect(log).toEqual(["ab reply ab:a:1"]);
	expect(port.of("a:ab")?.surface).toBe("a");
});

test("a reply to a prefix nobody serves, or a key with no prefix, is refused; the decorations do nothing", async () => {
	const port = surfacePort(() => [recording("a", [])]);
	await expect(port.sendReply("mcp:1", { chunks: [] })).rejects.toThrow(
		PluginError,
	);
	await expect(port.sendReply("mcp:1", { chunks: [] })).rejects.toThrow(
		'"mcp"',
	);
	await expect(
		port.sendReply("nocolon" as never, { chunks: [] }),
	).rejects.toThrow(PluginError);
	expect(port.of("nocolon" as never)).toBeUndefined();
	expect(port.of(":1")).toBeUndefined();
	port.startTyping("mcp:1")();
	port.showStop("mcp:1")();
	await port.react("mcp:1", "m", "x");
	await port.unreact("mcp:1", "m", "x");
	expect(port.prompts("mcp:1")).toBeUndefined();
});

test("a surface that lacks an optional method is skipped, not failed", async () => {
	const port = surfacePort(() => [recording("a", [], [])]);
	port.startTyping("a:1")();
	port.showStop("a:1")();
	await port.react("a:1", "m", "x");
	await port.unreact("a:1", "m", "x");
	expect(port.prompts("a:1")).toBeUndefined();
});

test("file sends require explicit capability and transport errors propagate", async () => {
	const file = { name: "image.png", data: new Uint8Array([1]) };
	const log: string[] = [];
	const unsupported = recording("a", log);
	const supported = { ...recording("b", log), supportsFiles: true };
	const broken = {
		...recording("c", log),
		supportsFiles: true,
		sendReply: async () => {
			throw new Error("upload rejected");
		},
	};
	const port = surfacePort(() => [unsupported, supported, broken]);
	await expect(
		port.sendReply("a:1", { chunks: [], files: [file] }),
	).rejects.toThrow("does not support reply files");
	expect(log).toEqual([]);
	await port.sendReply("b:1", { chunks: [], files: [file] });
	expect(log).toEqual(["b reply b:1"]);
	await expect(
		port.sendReply("c:1", { chunks: [], files: [file] }),
	).rejects.toThrow("upload rejected");
});

test("the surfaces are read when a call is made, so a port linked later still answers", async () => {
	let linked: ChatSurface[] | undefined;
	const port = surfacePort(() => {
		if (!linked) throw new Error("not linked");
		return linked;
	});
	expect(() => port.of("a:1")).toThrow("not linked");
	linked = [recording("a", [])];
	expect(port.of("a:1")?.surface).toBe("a");
});
