import { expect, test } from "bun:test";
import {
	AGENTS,
	type AgentRuntime,
	definePlugin,
	NotLinkedError,
	PluginError,
	RUNTIME,
	SCHEDULES,
	type Services,
	serviceKey,
} from "./index.ts";
import { servicePair, testPlugin } from "./testing.ts";

function probeServices(read: (services: Services) => unknown) {
	return definePlugin({
		name: "probe",
		setup: ({ services }) => {
			read(services);
			return { services: [{ name: "idle" }] };
		},
	});
}

test("services gives the plugin the members the test names, and refuses the others by name", async () => {
	const runtime = { stop: () => false } as unknown as AgentRuntime;
	let read: unknown;
	let refused: unknown;
	await testPlugin(
		probeServices((services) => {
			read = services.get(AGENTS).runtime;
			try {
				services.get(AGENTS).team;
			} catch (error) {
				refused = error;
			}
		}),
		{ services: [servicePair(AGENTS, { runtime })] },
	);
	expect(read).toBe(runtime);
	expect(refused).toBeInstanceOf(PluginError);
	expect(String(refused)).toContain(
		'testPlugin gave service roundtable.agents no "team". Give it in the services option: testPlugin(plugin, { services: [servicePair(KEY, { team: ... })] })',
	);
});

test("a runtime given under RUNTIME is the one context.turns runs on, kept whole", async () => {
	class Answering {
		readonly #text = "from RUNTIME";
		async runTurn() {
			return { ok: true as const, text: this.#text };
		}
	}
	const runtime = new Answering() as unknown as AgentRuntime;
	let read: unknown;
	const replies: string[] = [];
	const harness = await testPlugin(
		probeServices((services) => {
			read = services.get(RUNTIME);
		}),
		{
			services: [servicePair(RUNTIME, runtime)],
			surfaces: [
				{
					surface: "fake",
					start: async () => undefined,
					sendReply: async (_channel, reply) =>
						void replies.push(reply.chunks.join()),
				},
			],
		},
	);
	expect(read).toBe(runtime);
	const result = await harness.turns.run({
		channel: "fake:room",
		kind: "study",
		text: "hello",
		speaker: { id: "1", name: "Ada", tier: "member", principalId: "1" },
	});
	expect(result).toEqual({ ok: true, text: "from RUNTIME" });
	expect(replies).toEqual(["from RUNTIME"]);
	await harness.stop();
});

test("a plugin that fills the runtime slot reads its runtime under RUNTIME", async () => {
	const runtime = { stop: () => false } as unknown as AgentRuntime;
	let read: unknown;
	const harness = await testPlugin(
		definePlugin({
			name: "fills-and-reads",
			providers: { runtime: () => runtime },
			setup: ({ services }) => {
				read = services.get(RUNTIME);
				return {};
			},
		}),
	);
	expect(read).toBe(runtime);
	await harness.stop();
});

test("a service the test did not give says to pass it, and reads as absent to find", async () => {
	let refused = "";
	let found: unknown = "unset";
	await testPlugin(
		probeServices((services) => {
			found = services.find(SCHEDULES);
			try {
				services.get(SCHEDULES);
			} catch (error) {
				refused = String(error);
			}
		}),
	);
	expect(found).toBeUndefined();
	expect(refused).toContain("service roundtable.schedules is not provided.");
	expect(refused).toContain("give it in the services option");
	expect(refused).not.toContain("Register a plugin");
});

test("a plugin under test that requires a service has it given by the test, and is refused without", async () => {
	const key = serviceKey<{ n: number }>("probe.required");
	let read = 0;
	const plugin = definePlugin({
		name: "needs",
		requires: [key],
		setup: ({ services }) => {
			read = services.get(key).n;
			return { services: [{ name: "needs" }] };
		},
	});
	await testPlugin(plugin, { services: [servicePair(key, { n: 7 })] });
	expect(read).toBe(7);
	await expect(testPlugin(plugin)).rejects.toThrow(
		"plugin needs: requires service probe.required, which no registered plugin provides.",
	);
});

test("a lazy service of a plugin under test answers once setup is over", async () => {
	const key = serviceKey<{ n: number }>("probe.lazy");
	let reader: (() => { n: number }) | undefined;
	await testPlugin(
		probeServices((services) => {
			reader = services.lazy(key);
			expect(() => reader?.()).toThrow(NotLinkedError);
		}),
		{ services: [servicePair(key, { n: 3 })] },
	);
	expect(reader?.().n).toBe(3);
});

test("a plugin under test that declares a service must provide it, and may read its own", async () => {
	const key = serviceKey<{ n: number }>("probe.n");
	const harness = await testPlugin(
		definePlugin({
			name: "provider",
			provides: [key],
			setup: ({ services }) => {
				services.provide(key, { n: 1 });
				return { services: [{ name: "idle" }] };
			},
		}),
	);
	await harness.stop();
	await expect(
		testPlugin(
			definePlugin({
				name: "lazy",
				provides: [key],
				setup: () => ({ services: [{ name: "idle" }] }),
			}),
		),
	).rejects.toThrow(
		"plugin lazy: declares that it provides service probe.n, but setup did not provide it",
	);
});

test("a plugin written for 0.1.0 that reads context.core is refused, naming context.services", async () => {
	await expect(
		testPlugin(
			definePlugin({
				name: "old",
				setup: (context) => {
					// SAFETY: the removed property is read on purpose, to see how it fails.
					(context as unknown as { core: unknown }).core;
					return { services: [{ name: "idle" }] };
				},
			}),
		),
	).rejects.toThrow("plugin old: context.core was removed in 0.2.0");
});
