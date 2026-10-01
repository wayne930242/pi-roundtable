import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginError } from "./errors.ts";
import { Roundtable, type RoundtableOptions } from "./host.ts";
import { silentLogger } from "./log.ts";
import type { RoundtablePlugin, Service } from "./plugin.ts";

/** A service that records its start and stop in `log`. */
function recorded(
	name: string,
	log: string[],
	extra: Partial<Service> = {},
): Service {
	return {
		name,
		start: () => {
			log.push(`start ${name}`);
		},
		stop: () => {
			log.push(`stop ${name}`);
		},
		...extra,
	};
}

function plugin(name: string, services: Service[]): RoundtablePlugin {
	return { name, setup: () => ({ services }) };
}

/** Every host of the test, so one that a test leaves running never blocks the next: one runs per process. */
const hosts: Roundtable[] = [];
afterEach(async () => {
	for (const roundtable of hosts.splice(0)) await roundtable.shutdown("test");
});

function host(
	plugins: RoundtablePlugin[],
	options: Partial<RoundtableOptions> = {},
): { roundtable: Roundtable } {
	const roundtable = new Roundtable(
		{
			logger: silentLogger(),
			drain: { intervalMs: 1, limitMs: 50 },
			...options,
		},
		plugins,
	);
	hosts.push(roundtable);
	return { roundtable };
}

describe("the host's lifecycle hooks", () => {
	describe("background starts", () => {
		/** Runs a host whose services start in the background, and records what every plugin hears. */
		async function started(
			services: Service[],
			extra: RoundtablePlugin[] = [],
		): Promise<string[]> {
			const heard: string[] = [];
			const { roundtable } = host([
				{ name: "server", setup: () => ({ services }) },
				{
					name: "broken",
					setup: () => ({
						events: {
							serviceStarted: () => {
								throw new Error("channel missing");
							},
						},
					}),
				},
				{
					name: "listener",
					setup: () => ({
						events: {
							serviceStarted: ({ plugin, service, outcome }) => {
								heard.push(`${plugin}/${service} ${outcome}`);
							},
						},
					}),
				},
				...extra,
			]);
			await roundtable.run();
			await Bun.sleep(10);
			await roundtable.shutdown("SIGTERM");
			return heard;
		}

		test("tells every plugin how a service's background start ended, even after a handler fails", async () => {
			expect(
				await started([{ name: "team", startInBackground: async () => {} }]),
			).toEqual(["server/team ready"]);
			expect(
				await started([
					{
						name: "team",
						startInBackground: async () => {
							throw new Error("Missing Access");
						},
					},
				]),
			).toEqual(["server/team failed"]);
		});

		test("runs every service's background start; a failing one does not stop the other", async () => {
			const log: string[] = [];
			const heard = await started([
				{
					name: "one",
					startInBackground: async () => {
						log.push("one");
						throw new Error("boom");
					},
				},
				{
					name: "two",
					startInBackground: async () => {
						log.push("two");
					},
				},
				// Without one, the service has nothing to start and nothing to hear of.
				{ name: "three" },
			]);
			expect(log.toSorted()).toEqual(["one", "two"]);
			expect(heard.toSorted()).toEqual([
				"server/one failed",
				"server/two ready",
			]);
		});

		test("starts in the background after every service and the listeners are up, without holding up the boot", async () => {
			const log: string[] = [];
			const socketPath = join(mkdtempSync(join(tmpdir(), "host-")), "web.sock");
			const get = async () => {
				try {
					const response = await fetch("http://localhost/ping", {
						unix: socketPath,
					});
					return await response.text();
				} catch {
					return "closed";
				}
			};
			let release = () => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const { roundtable } = host(
				[
					{
						name: "a",
						setup: () => ({
							services: [
								{
									name: "a1",
									start: () => void log.push("start a1"),
									startInBackground: async () => {
										log.push(`background a1: ${await get()}`);
										await held;
									},
								},
							],
							http: [
								{
									name: "ping",
									listener: "web",
									path: { exact: "/ping" },
									handle: () => new Response("pong"),
								},
							],
						}),
					},
					{
						name: "b",
						setup: () => ({
							services: [
								{ name: "b1", start: () => void log.push("start b1") },
							],
						}),
					},
				],
				{ listeners: [{ id: "web", socketPath }] },
			);
			// `run` resolves while a1's background start is still held.
			await roundtable.run();
			await Bun.sleep(10);
			release();
			expect(log).toEqual(["start a1", "start b1", "background a1: pong"]);
			await roundtable.shutdown("SIGTERM");
		});

		test("a plugin hears a service ready only after its background start has done everything, as a release notice relies on", async () => {
			const log: string[] = [];
			const { roundtable } = host([
				{
					name: "server",
					setup: () => ({
						services: [
							{
								name: "team",
								startInBackground: async () => {
									await Bun.sleep(5);
									log.push("dashboard up");
								},
							},
						],
					}),
				},
				{
					name: "release",
					setup: () => ({
						events: {
							serviceStarted: ({ outcome }) => {
								log.push(`notice after ${outcome}`);
							},
						},
					}),
				},
			]);
			await roundtable.run();
			await Bun.sleep(20);
			expect(log).toEqual(["dashboard up", "notice after ready"]);
		});

		test("a service with a background start still stops with the others", async () => {
			const log: string[] = [];
			const { roundtable } = host([
				plugin("a", [
					recorded("a1", log, { startInBackground: async () => {} }),
				]),
			]);
			await roundtable.run();
			await Bun.sleep(5);
			await roundtable.shutdown("SIGTERM");
			expect(log).toEqual(["start a1", "stop a1"]);
		});
	});

	describe("a field of 0.1.0 that was removed", () => {
		const refused = async (plugin: object) => {
			const { roundtable } = host([plugin as RoundtablePlugin]);
			return await roundtable.run().catch((e: unknown) => e);
		};

		test("is refused with the replacement named, before anything is set up", async () => {
			let setUp = false;
			const setup = () => {
				setUp = true;
				return { services: [recorded("a1", [])] };
			};
			for (const [field, named] of [
				["useCommands", "commands.add"],
				["agentServer", "startInBackground"],
				["stopTurn", "stop(channel)"],
			] as const) {
				const error = await refused({ name: "old", [field]: () => {}, setup });
				expect(error).toBeInstanceOf(PluginError);
				expect((error as Error).message).toContain(`"${field}" was removed`);
				expect((error as Error).message).toContain(named);
			}
			expect(setUp).toBe(false);
		});

		test("is refused for the interactions part, naming the Discord registrar", async () => {
			const error = await refused({
				name: "old",
				setup: () => ({ interactions: [] }),
			});
			expect(error).toBeInstanceOf(PluginError);
			expect((error as Error).message).toBe(
				'plugin old: the "interactions" part was removed in 0.2.0; slash commands belong to the Discord plugin now; add them from setup with context.services.get(DISCORD).commands.add({ module, rootOptions }), with DISCORD from pi-roundtable/discord.',
			);
		});

		test("is refused for a surface's useCommands, which nothing calls any more", async () => {
			const error = await refused({
				name: "old",
				setup: () => ({
					surfaces: [
						{
							surface: "chat",
							start: async () => undefined,
							sendReply: async () => undefined,
							useCommands: () => undefined,
						},
					],
				}),
			});
			expect(error).toBeInstanceOf(PluginError);
			expect((error as Error).message).toContain(
				"plugin old: surface chat has useCommands, which was removed in 0.2.0",
			);
			expect((error as Error).message).toContain("commands.add");
		});

		test("is refused for the host option commands, naming the Discord plugin", async () => {
			const construct = () =>
				new Roundtable(
					{
						logger: silentLogger(),
						commands: {},
					} as unknown as RoundtableOptions,
					[],
				);
			expect(construct).toThrow(PluginError);
			expect(construct).toThrow("RoundtableOptions.commands was removed");
			expect(construct).toThrow("commands.add");
		});

		test("is refused for the agentServer event too, naming serviceStarted", async () => {
			const error = await refused({
				name: "old",
				setup: () => ({ events: { agentServer: () => {} } }),
			});
			expect(error).toBeInstanceOf(PluginError);
			expect((error as Error).message).toContain("serviceStarted");
		});
	});
});
