import { afterEach, describe, expect, test } from "bun:test";
import { serviceKey } from "./contract/services.ts";
import { PluginError } from "./errors.ts";
import { Roundtable } from "./host.ts";
import { silentLogger } from "./log.ts";
import type { PluginContext, RoundtablePlugin } from "./plugin.ts";

interface Counter {
	next(): number;
}
const COUNTER = serviceKey<Counter>("test.counter");
const LABEL = serviceKey<{ text: string }>("test.label");

/** Every host of the test, so one that a test leaves running never blocks the next: one runs per process. */
const hosts: Roundtable[] = [];
afterEach(async () => {
	for (const roundtable of hosts.splice(0)) await roundtable.shutdown("test");
});

/** Runs a host over the plugins and returns what its setups did, or the error that stopped it. */
async function run(plugins: RoundtablePlugin[]): Promise<unknown> {
	const roundtable = new Roundtable({ logger: silentLogger() }, plugins);
	hosts.push(roundtable);
	try {
		await roundtable.run();
		return undefined;
	} catch (error) {
		return error;
	}
}

/** A plugin that provides `COUNTER`, logging its setup. */
function counting(name: string, log: string[], start = 0): RoundtablePlugin {
	return {
		name,
		provides: [COUNTER],
		setup: ({ services }) => {
			log.push(`setup ${name}`);
			let n = start;
			services.provide(COUNTER, { next: () => ++n });
			return { services: [{ name }] };
		},
	};
}

/** A plugin that reads what the others provide and does nothing else. */
function reading(
	name: string,
	read: (context: PluginContext) => void,
): RoundtablePlugin {
	return {
		name,
		setup: (context) => {
			read(context);
			return { services: [{ name }] };
		},
	};
}

describe("provides", () => {
	test("a plugin reads what an earlier plugin provided", async () => {
		const seen: number[] = [];
		const error = await run([
			counting("counter", []),
			reading("reader", ({ services }) => {
				seen.push(services.get(COUNTER).next());
			}),
		]);
		expect(error).toBeUndefined();
		expect(seen).toEqual([1]);
	});

	test("providing a key the plugin does not declare is refused, naming the fix", async () => {
		const error = await run([
			{
				name: "sneaky",
				setup: ({ services }) => {
					services.provide(COUNTER, { next: () => 1 });
					return { services: [{ name: "sneaky" }] };
				},
			},
		]);
		expect(error).toBeInstanceOf(PluginError);
		expect(String(error)).toContain(
			"plugin sneaky: cannot provide service test.counter, which it does not declare. Add it to the plugin's provides.",
		);
	});

	test("a key declared but not provided is refused once setup returns", async () => {
		const error = await run([
			{
				name: "forgetful",
				provides: [COUNTER],
				setup: () => ({ services: [{ name: "forgetful" }] }),
			},
		]);
		expect(error).toBeInstanceOf(PluginError);
		expect(String(error)).toContain(
			"plugin forgetful: declares that it provides service test.counter, but setup did not provide it.",
		);
	});

	test("a key provided twice is refused", async () => {
		const error = await run([
			{
				name: "twice",
				provides: [COUNTER],
				setup: ({ services }) => {
					services.provide(COUNTER, { next: () => 1 });
					services.provide(COUNTER, { next: () => 2 });
					return { services: [{ name: "twice" }] };
				},
			},
		]);
		expect(String(error)).toContain(
			"plugin twice: service test.counter is provided twice.",
		);
	});

	test("two plugins declaring one key are refused before any setup, unless one replaces the other", async () => {
		const log: string[] = [];
		const error = await run([counting("a", log), counting("b", log)]);
		expect(error).toBeInstanceOf(PluginError);
		expect(String(error)).toContain(
			"plugin b: service test.counter is also provided by plugin a.",
		);
		expect(log).toEqual([]);
	});

	test("providing after setup has returned is refused", async () => {
		let later: (() => void) | undefined;
		const error = await run([
			{
				name: "late",
				provides: [COUNTER],
				setup: ({ services }) => {
					services.provide(COUNTER, { next: () => 1 });
					later = () => services.provide(COUNTER, { next: () => 2 });
					return { services: [{ name: "late" }] };
				},
			},
		]);
		expect(error).toBeUndefined();
		expect(() => later?.()).toThrow("services are provided from setup only");
	});

	test("a provides entry that is not a key is refused", async () => {
		const error = await run([
			{
				name: "bad",
				provides: ["test.counter"] as never,
				setup: () => ({ services: [{ name: "bad" }] }),
			},
		]);
		expect(String(error)).toContain(
			"provides has an entry that is not a service key",
		);
	});
});

describe("get and find", () => {
	test("get of a service nobody declares says to register a plugin that provides it", async () => {
		const error = await run([
			reading("reader", ({ services }) => services.get(COUNTER)),
		]);
		expect(error).toBeInstanceOf(PluginError);
		expect(String(error)).toContain(
			"service test.counter is not provided. Register a plugin that provides it, before the plugin that reads it.",
		);
	});

	test("get of a service declared by a plugin registered later names that plugin and the order", async () => {
		const error = await run([
			reading("reader", ({ services }) => services.get(COUNTER)),
			counting("counter", []),
		]);
		expect(String(error)).toContain(
			"service test.counter is not provided yet; plugin counter provides it. Register plugin counter before plugin reader.",
		);
	});

	test("find is undefined when no plugin declares the service, and throws when one declares it but is not set up yet", async () => {
		const found: unknown[] = [];
		expect(
			await run([
				reading("off", ({ services }) => {
					found.push(services.find(COUNTER));
				}),
			]),
		).toBeUndefined();
		expect(found).toEqual([undefined]);
		await Promise.all(
			hosts.splice(0).map((roundtable) => roundtable.shutdown("test")),
		);
		const error = await run([
			reading("early", ({ services }) => services.find(COUNTER)),
			counting("counter", []),
		]);
		expect(String(error)).toContain("service test.counter is not provided yet");
	});

	test("find gives the service once it is provided", async () => {
		let found: Counter | undefined;
		await run([
			counting("counter", []),
			reading("reader", ({ services }) => {
				found = services.find(COUNTER);
			}),
		]);
		expect(found?.next()).toBe(1);
	});
});

describe("replaces", () => {
	test("the replacement is set up where the plugin it replaces stood, and the replaced one never runs", async () => {
		const log: string[] = [];
		const migrated: string[] = [];
		const builtin: RoundtablePlugin = {
			...counting("builtin", log),
			migrations: [
				{
					name: "builtin-table",
					up: async () => void migrated.push("builtin"),
				},
			],
		};
		const mine: RoundtablePlugin = {
			...counting("mine", log, 100),
			replaces: [COUNTER],
		};
		const reader = reading("reader", ({ services }) => {
			log.push(`reader sees ${services.get(COUNTER).next()}`);
		});
		const error = await run([builtin, mine, reader]);
		expect(error).toBeUndefined();
		expect(log).toEqual(["setup mine", "reader sees 101"]);
		expect(migrated).toEqual([]);
	});

	test("the replacement stands at the position of the plugin it replaces, not where it was listed", async () => {
		const log: string[] = [];
		const error = await run([
			reading("before", () => void log.push("before")),
			counting("builtin", log),
			reading("after", () => void log.push("after")),
			{ ...counting("mine", log), replaces: [COUNTER] },
		]);
		expect(error).toBeUndefined();
		expect(log).toEqual(["before", "setup mine", "after"]);
	});

	test("a key nobody else provides is refused", async () => {
		const error = await run([{ ...counting("mine", []), replaces: [COUNTER] }]);
		expect(error).toBeInstanceOf(PluginError);
		expect(String(error)).toContain(
			"plugin mine: replaces service test.counter, which no other registered plugin provides.",
		);
	});

	test("two plugins replacing one key are refused", async () => {
		const error = await run([
			counting("builtin", []),
			{ ...counting("one", []), replaces: [COUNTER] },
			{ ...counting("two", []), replaces: [COUNTER] },
		]);
		expect(String(error)).toContain(
			"plugin two: service test.counter is also replaced by plugin one.",
		);
	});

	test("a partial replacement is refused: the dropped plugin provides a key the replacement does not replace", async () => {
		const builtin: RoundtablePlugin = {
			name: "builtin",
			provides: [COUNTER, LABEL],
			setup: ({ services }) => {
				services.provide(COUNTER, { next: () => 1 });
				services.provide(LABEL, { text: "built in" });
				return { services: [{ name: "builtin" }] };
			},
		};
		const error = await run([
			builtin,
			{ ...counting("mine", []), replaces: [COUNTER] },
		]);
		expect(error).toBeInstanceOf(PluginError);
		expect(String(error)).toContain(
			"plugin mine: replacing plugin builtin would drop test.label too, which it also provides.",
		);
	});

	test("replacing every key of a plugin that provides several is allowed", async () => {
		const seen: string[] = [];
		const builtin: RoundtablePlugin = {
			name: "builtin",
			provides: [COUNTER, LABEL],
			setup: ({ services }) => {
				services.provide(COUNTER, { next: () => 1 });
				services.provide(LABEL, { text: "built in" });
				return { services: [{ name: "builtin" }] };
			},
		};
		const mine: RoundtablePlugin = {
			name: "mine",
			provides: [COUNTER, LABEL],
			replaces: [COUNTER, LABEL],
			setup: ({ services }) => {
				services.provide(COUNTER, { next: () => 7 });
				services.provide(LABEL, { text: "mine" });
				return { services: [{ name: "mine" }] };
			},
		};
		const error = await run([
			builtin,
			mine,
			reading("reader", ({ services }) => {
				seen.push(
					services.get(LABEL).text,
					String(services.get(COUNTER).next()),
				);
			}),
		]);
		expect(error).toBeUndefined();
		expect(seen).toEqual(["mine", "7"]);
	});

	test("a replaced key the replacement does not list in provides is refused", async () => {
		const error = await run([
			counting("builtin", []),
			{
				name: "mine",
				replaces: [COUNTER],
				setup: () => ({ services: [{ name: "mine" }] }),
			},
		]);
		expect(String(error)).toContain(
			"plugin mine: replaces service test.counter but does not list it in provides.",
		);
	});
});

describe("context.core of 0.1.0", () => {
	test("reading it is refused, naming context.services", async () => {
		const error = await run([
			{
				name: "old",
				setup: (context) => {
					// SAFETY: the removed property is read on purpose, to see how it fails.
					(context as unknown as { core: unknown }).core;
					return { services: [{ name: "old" }] };
				},
			},
		]);
		expect(error).toBeInstanceOf(PluginError);
		expect(String(error)).toContain(
			"plugin old: context.core was removed in 0.2.0; read a service with context.services.get(KEY)",
		);
	});
});

describe("serviceKey", () => {
	test("needs an id, and two keys with one id are one service", () => {
		expect(() => serviceKey("")).toThrow("a service key needs an id");
		expect(serviceKey("a.b").id).toBe(serviceKey("a.b").id);
		expect(Object.isFrozen(serviceKey("a.b"))).toBe(true);
	});
});
