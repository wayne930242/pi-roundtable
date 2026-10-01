import { afterEach, expect, test } from "bun:test";
import {
	type ChatSurface,
	definePlugin,
	NotLinkedError,
	PluginError,
	Roundtable,
	type RoundtablePlugin,
	type SurfacePort,
} from "pi-roundtable";
import { silentLogger } from "pi-roundtable/testing";
import { FakeSurface, fakeChat } from "./fake-surface.ts";

/** One host runs per process, so each test stops its own. */
const hosts: Roundtable[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.shutdown("test");
});

function host(
	plugins: RoundtablePlugin[],
	options: Partial<ConstructorParameters<typeof Roundtable>[0]> = {},
): Roundtable {
	const roundtable = new Roundtable(
		{ logger: silentLogger(), ...options },
		plugins,
	);
	hosts.push(roundtable);
	return roundtable;
}

async function until(done: () => boolean): Promise<void> {
	for (let waited = 0; !done() && waited < 1000; waited += 5)
		await Bun.sleep(5);
	expect(done()).toBe(true);
}

/** The surface port the host gave a plugin, for a test to call once the host is running. */
function portOf(): { plugin: RoundtablePlugin; port: () => SurfacePort } {
	let port: SurfacePort | undefined;
	return {
		plugin: definePlugin({
			name: "port-probe",
			setup: ({ surfaces }) => {
				port = surfaces;
				return { services: [{ name: "probe" }] };
			},
		}),
		port: () => {
			if (!port) throw new Error("the plugin was not set up");
			return port;
		},
	};
}

test("a message of the surface reaches the claim on its keys, and the reply goes out through the surface", async () => {
	const surface = new FakeSurface();
	await host([fakeChat(surface)]).run();
	surface.say("fake:room", "hello");
	await until(() => surface.replies.length > 0);
	expect(surface.replies).toEqual([
		{ channel: "fake:room", reply: { chunks: ["echo: hello"] } },
	]);
	expect(surface.typing).toEqual(["start fake:room", "stop fake:room"]);
});

test("a message whose channel belongs to another surface is dropped, not handed to the claim", async () => {
	const surface = new FakeSurface();
	await host([fakeChat(surface)]).run();
	surface.say("discord:room", "hello");
	await Bun.sleep(30);
	expect(surface.replies).toEqual([]);
	surface.say("fake:room", "again");
	await until(() => surface.replies.length > 0);
	expect(surface.replies.map(({ channel }) => channel)).toEqual(["fake:room"]);
});

test("the port picks the surface by the key's prefix and refuses a prefix nobody serves", async () => {
	const surface = new FakeSurface();
	const probe = portOf();
	await host([fakeChat(surface), probe.plugin]).run();
	const surfaces = probe.port();
	expect(surfaces.of("fake:1")).toBe(surface);
	expect(surfaces.of("mcp:1")).toBeUndefined();
	await surfaces.sendReply("fake:1", { chunks: ["hi"] });
	expect(surface.replies).toHaveLength(1);
	const refused = await surfaces.sendReply("mcp:1", { chunks: ["hi"] }).then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(refused).toBeInstanceOf(PluginError);
	expect(String(refused)).toContain("mcp");
	// What a surface does not show is a no-op, and a prefix nobody serves has nothing to show.
	surfaces.showStop("fake:1")();
	surfaces.showStop("mcp:1")();
	surfaces.startTyping("mcp:1")();
	expect(surface.stops).toEqual(["show fake:1", "hide fake:1"]);
});

test("the owner's approvals in a channel of the surface use the surface's prompts, and other channels have none", async () => {
	const surface = new FakeSurface();
	const probe = portOf();
	await host([fakeChat(surface), probe.plugin]).run();
	const prompts = probe.port().prompts("fake:1");
	expect(await prompts?.confirm("Run rm?", "deletes the notes")).toBe(
		"approved",
	);
	expect(surface.asked).toEqual(["fake:1: Run rm?"]);
	expect(probe.port().prompts("mcp:1")).toBeUndefined();
});

test("two surfaces with one prefix are refused, naming both plugins", async () => {
	const second = definePlugin({
		name: "second-chat",
		setup: () => ({ surfaces: [new FakeSurface()] }),
	});
	const error = await host([fakeChat(new FakeSurface()), second])
		.run()
		.then(
			() => undefined,
			(failure: unknown) => failure,
		);
	expect(error).toBeInstanceOf(PluginError);
	expect(String(error)).toContain(
		"surface fake is already registered by plugin fake-chat",
	);
});

test("a surface is started before the plugin's own services and stopped after them", async () => {
	const log: string[] = [];
	const surface: ChatSurface = {
		surface: "log",
		start: async () => void log.push("start surface"),
		stop: async () => void log.push("stop surface"),
		sendReply: async () => undefined,
	};
	const plugin = definePlugin({
		name: "log-chat",
		setup: () => ({
			services: [
				{
					name: "after",
					start: () => void log.push("start service"),
					stop: () => void log.push("stop service"),
				},
			],
			surfaces: [surface],
		}),
	});
	const roundtable = host([plugin]);
	await roundtable.run();
	await roundtable.shutdown("test");
	expect(log).toEqual([
		"start surface",
		"start service",
		"stop service",
		"stop surface",
	]);
});

test("surfaces are not available during setup", async () => {
	const early = definePlugin({
		name: "early",
		setup: ({ surfaces }) => {
			surfaces.of("fake:1");
			return {};
		},
	});
	const error = await host([early])
		.run()
		.then(
			() => undefined,
			(failure: unknown) => failure,
		);
	expect(error).toBeInstanceOf(PluginError);
	expect(String(error)).toContain(
		"chat surfaces are linked once every plugin is set up",
	);
	expect((error as PluginError).cause).toBeInstanceOf(NotLinkedError);
});
