import { afterAll, beforeEach, expect } from "bun:test";
import type { SQL } from "bun";
import type {
	Contribution,
	PluginContext,
	Service,
	ServiceKey,
} from "pi-roundtable";
import { partial, recordingLogger } from "pi-roundtable/testing";
import { line } from "../plugin.ts";
import { LINE, type LineBridgePort } from "../port.ts";
import { CHANNEL_ID, fakeLine, SECRET } from "./line-fake.ts";
import { freshPool, truncateAll } from "./pool.ts";

export const credentials = { channelId: CHANNEL_ID, channelSecret: SECRET };

export let sql: SQL;

export const START = new Date("2026-10-13T00:00:00Z");

export let time = START;

/** How long the inbox puts an event back when its subscriber goes before it is handed over. */
export const POLL_MS = 20;

/** Lets time pass on the frozen clock, which otherwise stands still. */
export const advance = (ms: number) => {
	time = new Date(time.getTime() + ms);
};

export const logs = recordingLogger();

export let provided: unknown;

/** The tests that need time to pass (the outbox's window) run on the real clock. */
export const ctl = { realClock: false };

export const context = (database: SQL = sql): PluginContext =>
	partial<PluginContext>({
		logger: logs.logger,
		env: partial<PluginContext["env"]>({
			now: () => (ctl.realClock ? new Date() : time),
		}),
		database: () => database,
		services: partial<PluginContext["services"]>({
			provide: <T>(key: ServiceKey<T>, value: T) => {
				expect(key.id).toBe(LINE.id);
				provided = value;
			},
		}),
	});

export const boot = async (
	options: Partial<Parameters<typeof line>[0]> = {},
	database?: SQL,
) => {
	const fake = fakeLine();
	const plugin = line({
		credentials,
		fetch: fake.fetch,
		inbox: { pollMs: POLL_MS },
		...options,
	});
	const contribution: Contribution = await plugin.setup(context(database));
	const service = (name: string): Service => {
		const found = contribution.services?.find((s) => s.name === name);
		if (!found) throw new Error(`no service ${name}`);
		return found;
	};
	const route = contribution.http?.find((r) => r.name === "line-webhook");
	if (!route) throw new Error("no route");
	return {
		fake,
		plugin,
		contribution,
		service,
		route,
		port: provided as LineBridgePort,
	};
};

/** Waits until `done` holds, polling the real clock. */
export const until = async (
	done: () => boolean | Promise<boolean>,
	turns = 600,
) => {
	for (let i = 0; i < turns && !(await done()); i++) await Bun.sleep(10);
};

export const FAST = {
	outbox: { coalesceMs: 20, pollMs: 10 },
	inbox: { pollMs: 10 },
};

export function usePluginHarness() {
	beforeEach(async () => {
		sql ??= await freshPool();
		await truncateAll(sql);
		logs.lines.length = 0;
		provided = undefined;
		ctl.realClock = false;
		time = START;
	});

	afterAll(async () => {
		await sql?.close();
		// The next file opens its own pool.
		sql = undefined as never;
	});
}
