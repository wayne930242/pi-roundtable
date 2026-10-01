import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { QueuePort } from "./contract/channels.ts";
import { defineTool } from "./define.ts";
import { PluginError } from "./errors.ts";
import { Roundtable, type RoundtableOptions } from "./host.ts";
import { assistantName } from "./i18n/index.ts";
import { silentLogger } from "./log.ts";
import type { HostEnv, RoundtablePlugin, Service } from "./plugin.ts";
import { useTestLocale } from "./testing/locale.ts";
import { timeZone, zonedStamp } from "./time.ts";

// One host runs per process, so a test never leaves one running for the next.
const hosts: Roundtable[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.shutdown("test");
	useTestLocale();
});

function host(
	plugins: RoundtablePlugin[],
	options: Partial<RoundtableOptions> = {},
): Roundtable {
	const roundtable = new Roundtable(
		{
			logger: silentLogger(),
			drain: { intervalMs: 1, limitMs: 50 },
			...options,
		},
		plugins,
	);
	hosts.push(roundtable);
	return roundtable;
}

const service = (
	name: string,
	log: string[],
	extra: Partial<Service> = {},
): Service => ({
	name,
	start: () => void log.push(`start ${name}`),
	stop: () => void log.push(`stop ${name}`),
	...extra,
});

const withServices = (
	name: string,
	...services: Service[]
): RoundtablePlugin => ({ name, setup: () => ({ services }) });

const boom = (name: string): Service => ({
	name,
	start: () => {
		throw new Error(`${name} could not start`);
	},
});

/** A surface that is not Discord: it only takes the host's queue. */
function surface(taken: { queue?: QueuePort }): RoundtablePlugin {
	return {
		name: "webhook-surface",
		setup: (context) => {
			taken.queue = context.queue;
			return { services: [{ name: "surface" }] };
		},
	};
}

describe("the host's environment", () => {
	test("belongs to each host: building applies nothing, and plugins read their own host's", async () => {
		const at = new Date("2026-09-30T00:00:00Z");
		const seen: Record<string, HostEnv> = {};
		const reader = (name: string): RoundtablePlugin => ({
			name,
			setup: ({ env }) => {
				seen[name] = env;
				return { events: {} };
			},
		});
		const a = host([reader("a")], {
			environment: {
				locale: "en",
				timeZone: "America/New_York",
				assistant: "Alpha",
				rootCommand: "alpha",
			},
		});
		const b = host([reader("b")], {
			environment: {
				locale: "zh-TW",
				timeZone: "Asia/Taipei",
				assistant: "Beta",
				rootCommand: "beta",
			},
		});
		// Building both hosts touched nothing in the process.
		expect(timeZone()).toBe("UTC");
		expect(assistantName()).toBe("Roundtable");

		await a.run();
		expect(assistantName()).toBe("Alpha");
		expect(zonedStamp(at)).toBe("2026-09-29 20:00");
		await a.shutdown("test");
		await b.run();
		expect(assistantName()).toBe("Beta");
		expect(zonedStamp(at)).toBe("2026-09-30 08:00");

		expect(seen.a).toMatchObject({
			locale: "en",
			timeZone: "America/New_York",
		});
		expect(seen.b).toMatchObject({ locale: "zh-TW", timeZone: "Asia/Taipei" });
		expect(seen.a?.now()).toBeInstanceOf(Date);
	});

	test("run exports the Pi agent directory, and only run does", async () => {
		const before = process.env.PI_CODING_AGENT_DIR;
		try {
			const roundtable = host([withServices("p", { name: "s" })], {
				environment: { agentDir: "/tmp/host-lifecycle-agent" },
			});
			expect(process.env.PI_CODING_AGENT_DIR).toBe(before);
			await roundtable.run();
			expect(process.env.PI_CODING_AGENT_DIR).toBe("/tmp/host-lifecycle-agent");
		} finally {
			if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = before;
		}
	});

	test("an omitted environment is the neutral one", async () => {
		let seen: HostEnv | undefined;
		await host([
			{
				name: "p",
				setup: ({ env }) => {
					seen = env;
					return { events: {} };
				},
			},
		]).run();
		expect(seen).toMatchObject({ locale: "en", timeZone: "UTC" });
	});
});

describe("one host per process", () => {
	test("a second run is refused, naming the fix, until the first has stopped", async () => {
		const first = host([withServices("p", { name: "s" })]);
		const second = host([withServices("q", { name: "t" })]);
		await first.run();
		const error = await second.run().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(PluginError);
		expect((error as Error).message).toContain("already running");
		expect((error as Error).message).toContain("separate process");
		await first.shutdown("test");
		await second.run();
	});

	test("the same host cannot run twice at once", async () => {
		const roundtable = host([withServices("p", { name: "s" })]);
		await roundtable.run();
		await expect(roundtable.run()).rejects.toThrow("already running");
	});

	test("a failed start gives the slot back, and a retry re-declares its tools safely", async () => {
		let attempts = 0;
		const tool = defineTool({
			name: "lookup",
			description: "A tool.",
			parameters: Type.Object({}),
			minTier: "member",
			run: () => "ok",
		});
		const roundtable = host([
			{
				name: "tools",
				preflight: () => {
					attempts += 1;
					if (attempts === 1) throw new Error("not yet");
				},
				setup: () => ({ tools: [tool] }),
			},
		]);
		await expect(roundtable.run()).rejects.toThrow("not yet");
		await roundtable.run();
		expect(attempts).toBe(2);
	});
});

describe("a failed start", () => {
	test("stops what started in reverse, then rethrows, and the process is free again", async () => {
		const log: string[] = [];
		const roundtable = host([
			withServices("a", service("gateway", log), service("second", log)),
			withServices("b", boom("boom")),
		]);
		await expect(roundtable.run()).rejects.toThrow("boom could not start");
		expect(log).toEqual([
			"start gateway",
			"start second",
			"stop second",
			"stop gateway",
		]);
		// Another host may start in this process.
		await host([withServices("c", { name: "s" })]).run();
	});

	test("a failing preflight starts nothing, and the retry then starts everything", async () => {
		const log: string[] = [];
		let fails = true;
		const roundtable = host([
			{
				name: "a",
				preflight: () => {
					if (fails) throw new Error("misconfigured");
				},
				setup: () => ({ services: [service("gateway", log)] }),
			},
		]);
		await expect(roundtable.run()).rejects.toThrow("misconfigured");
		expect(log).toEqual([]);
		fails = false;
		await roundtable.run();
		expect(log).toEqual(["start gateway"]);
	});

	test("a listener that cannot open stops the services and the listeners already open", async () => {
		const busy = Bun.serve({ port: 0, fetch: () => new Response("busy") });
		const socketPath = join(
			mkdtempSync(join(tmpdir(), "host-lifecycle-")),
			"web.sock",
		);
		const log: string[] = [];
		try {
			const roundtable = host([withServices("a", service("surface", log))], {
				listeners: [
					{ id: "first", socketPath },
					{ id: "second", port: busy.port as number },
				],
			});
			await expect(roundtable.run()).rejects.toBeInstanceOf(Error);
			expect(log).toEqual(["start surface", "stop surface"]);
			// The listener that had opened is closed again.
			const reply = await fetch("http://host/", { unix: socketPath }).catch(
				() => undefined,
			);
			expect(reply).toBeUndefined();
		} finally {
			void busy.stop(true);
		}
	});

	test("a signal afterwards ends the process non-zero, not zero", async () => {
		const roundtable = host([withServices("a", boom("boom"))]);
		await expect(roundtable.run()).rejects.toThrow();
		expect(await roundtable.shutdown("SIGTERM")).toBe(1);
	});
});

describe("shutdown", () => {
	test("drains the host's own channel queue, whatever surface the plugins run", async () => {
		const taken: { queue?: QueuePort } = {};
		let finished = false;
		const roundtable = host([surface(taken)], {
			drain: { intervalMs: 5, limitMs: 5_000 },
		});
		await roundtable.run();
		void taken.queue?.run("webhook:1", async () => {
			await Bun.sleep(100);
			finished = true;
		});
		const code = await roundtable.shutdown("SIGTERM");
		expect(finished).toBe(true);
		expect(code).toBe(0);
	});

	test("hands over the queue's channel once when the limit runs out", async () => {
		const taken: { queue?: QueuePort } = {};
		const aborted: string[][] = [];
		const roundtable = host([surface(taken)], {
			aborted: async (left) => void aborted.push(left),
		});
		await roundtable.run();
		const stuck = Promise.withResolvers<void>();
		void taken.queue?.run("webhook:1", () => stuck.promise);
		await roundtable.shutdown("SIGTERM");
		stuck.resolve();
		expect(aborted).toEqual([["webhook:1"]]);
	});

	test("runs once however often it is asked, and every asker gets the one code", async () => {
		const log: string[] = [];
		const roundtable = host([withServices("a", service("a1", log))]);
		await roundtable.run();
		const [first, second] = await Promise.all([
			roundtable.shutdown("SIGTERM"),
			roundtable.shutdown("SIGINT"),
		]);
		expect(await roundtable.shutdown("SIGTERM")).toBe(0);
		expect([first, second]).toEqual([0, 0]);
		expect(log).toEqual(["start a1", "stop a1"]);
	});

	test("returns non-zero when something did not stop, and still stops the rest", async () => {
		const log: string[] = [];
		const roundtable = host([
			withServices("a", service("a1", log), {
				name: "broken",
				stop: () => {
					throw new Error("socket already closed");
				},
			}),
		]);
		await roundtable.run();
		expect(await roundtable.shutdown("SIGTERM")).toBe(1);
		expect(log).toEqual(["start a1", "stop a1"]);
	});

	test("listen exits once with the code, however many signals come", async () => {
		const log: string[] = [];
		const exits: number[] = [];
		const roundtable = host([withServices("a", service("a1", log))], {
			exit: (code) => void exits.push(code),
		});
		roundtable.listen();
		await roundtable.run();
		process.emit("SIGTERM");
		process.emit("SIGINT");
		while (exits.length === 0) await Bun.sleep(1);
		await Bun.sleep(20);
		expect(exits).toEqual([0]);
		expect(log).toEqual(["start a1", "stop a1"]);
	});
});
