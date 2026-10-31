import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { PluginError } from "../errors.ts";
import { SYSTEM_PRINCIPAL } from "../identity/principal-store.ts";
import { silentLogger } from "../log.ts";
import type { ChannelKey } from "../sessions.ts";
import type { Speaker } from "../speakers.ts";
import {
	type ConversationMode,
	PgConversationModes,
} from "./conversation-modes.ts";
import {
	followersOf,
	type ModeOrigins,
	resolveMode,
	type StoredMode,
} from "./mode-inheritance.ts";

const owner: Speaker = {
	id: "100",
	name: "Ada",
	tier: "owner",
	principalId: "p-ada",
};
const member: Speaker = { ...owner, tier: "member", principalId: "p-bo" };
const parent = "app:agent.infra" as ChannelKey;
const helper = "app:agent.infra-1" as ChannelKey;
const thread = "discord:777" as ChannelKey;

/** Origins as the agent server tells them, from a table the test changes. */
function origins(table: Map<ChannelKey, { name: string; alive: boolean }>) {
	return {
		originOf: (channel: ChannelKey, origin: ChannelKey) =>
			origin === parent ? table.get(channel) : undefined,
	} satisfies ModeOrigins;
}

describe("resolveMode", () => {
	const on = (yolo: boolean, longRunning: boolean): StoredMode => ({
		own: { yolo, longRunning, changedBy: "p-ada" },
	});

	test("a conversation never stored reads off, one with its own modes reads them", () => {
		const rows = new Map<ChannelKey, StoredMode>([[parent, on(true, false)]]);
		expect(resolveMode(helper, (k) => rows.get(k), undefined)).toEqual({
			yolo: false,
			longRunning: false,
		});
		expect(resolveMode(parent, (k) => rows.get(k), undefined).yolo).toBe(true);
	});

	test("a follower reads its origin's modes live, both ways, named by the origins", () => {
		const rows = new Map<ChannelKey, StoredMode>([
			[parent, on(true, true)],
			[helper, { own: on(false, false).own, follows: parent }],
		]);
		const told = origins(new Map([[helper, { name: "Infra", alive: true }]]));
		expect(resolveMode(helper, (k) => rows.get(k), told)).toEqual({
			yolo: true,
			longRunning: true,
			changedBy: "p-ada",
			inheritedFrom: { channel: parent, name: "Infra" },
		});
		rows.set(parent, on(false, false));
		expect(resolveMode(helper, (k) => rows.get(k), told)).toMatchObject({
			yolo: false,
			longRunning: false,
			inheritedFrom: { channel: parent },
		});
	});

	test("an origin that is gone reads off, and says so", () => {
		const rows = new Map<ChannelKey, StoredMode>([
			[parent, on(true, true)],
			[helper, { own: on(false, false).own, follows: parent }],
		]);
		const told = origins(new Map([[helper, { name: "Infra", alive: false }]]));
		expect(resolveMode(helper, (k) => rows.get(k), told)).toEqual({
			yolo: false,
			longRunning: false,
			inheritedFrom: { channel: parent, name: "Infra", gone: true },
		});
	});

	test("a conversation that no longer follows reads its own modes; without origins it still follows", () => {
		const rows = new Map<ChannelKey, StoredMode>([
			[parent, on(true, true)],
			[helper, { own: on(false, true).own, follows: parent }],
		]);
		expect(resolveMode(helper, (k) => rows.get(k), origins(new Map()))).toEqual(
			on(false, true).own,
		);
		expect(resolveMode(helper, (k) => rows.get(k), undefined)).toMatchObject({
			yolo: true,
			inheritedFrom: { channel: parent },
		});
	});

	test("followersOf lists only the conversations that follow the origin now", () => {
		const rows = new Map<ChannelKey, StoredMode>([
			[parent, on(true, true)],
			[helper, { own: on(false, false).own, follows: parent }],
			[thread, { own: on(false, false).own, follows: parent }],
		]);
		const told = origins(new Map([[helper, { name: "Infra", alive: true }]]));
		expect(followersOf(parent, rows, told)).toEqual([helper]);
		expect(followersOf(parent, rows, undefined)).toEqual([helper, thread]);
		expect(followersOf(helper, rows, told)).toEqual([]);
	});
});

interface Row {
	channel: string;
	yolo: boolean;
	long_running: boolean;
	changed_by: string | null;
	changed_at: Date;
	follows: string | null;
}

/** The modes' four statements over a table in memory: read all, set, follow and delete. */
function fakeSql() {
	const rows = new Map<string, Row>();
	const sql = (strings: readonly string[], ...values: unknown[]) => {
		const text = strings.join("?");
		if (text.includes("SELECT * FROM conversation_modes"))
			return Promise.resolve([...rows.values()]);
		if (text.includes("DELETE FROM conversation_modes")) {
			rows.delete(values[0] as string);
			return Promise.resolve([]);
		}
		let row: Row;
		if (text.includes(", false, false, ")) {
			const [channel, by, origin] = values as [string, string, string];
			row = {
				channel,
				yolo: false,
				long_running: false,
				changed_by: by,
				changed_at: new Date(),
				follows: origin,
			};
		} else {
			const [channel, yolo, longRunning, by] = values as [
				string,
				boolean | null,
				boolean | null,
				string,
			];
			const old = rows.get(channel);
			row = {
				channel,
				yolo: yolo ?? old?.yolo ?? false,
				long_running: longRunning ?? old?.long_running ?? false,
				changed_by: by,
				changed_at: new Date(),
				follows: null,
			};
		}
		rows.set(row.channel, row);
		return Promise.resolve([row]);
	};
	return { sql: sql as unknown as SQL, rows };
}

describe("PgConversationModes, a conversation that follows another", () => {
	const setup = async (
		table = new Map([[helper, { name: "Infra", alive: true }]]),
	) => {
		const fake = fakeSql();
		const modes = PgConversationModes.attach(fake.sql, silentLogger());
		await modes.load();
		modes.trackOrigins(origins(table));
		const heard: [ChannelKey, ConversationMode][] = [];
		modes.onChange((channel, mode) => heard.push([channel, mode]));
		return { ...fake, modes, heard, table };
	};

	test("a follower follows its origin live, both modes, both ways, and its listeners hear each change", async () => {
		const { modes, heard } = await setup();
		await modes.follow([helper], parent, owner);
		expect(modes.peek(helper)).toMatchObject({
			yolo: false,
			longRunning: false,
			inheritedFrom: { channel: parent, name: "Infra" },
		});
		await modes.set(parent, { yolo: true, longRunning: true }, owner);
		expect(modes.peek(helper)).toMatchObject({ yolo: true, longRunning: true });
		await modes.set(parent, { yolo: false }, owner);
		expect(modes.peek(helper)).toMatchObject({
			yolo: false,
			longRunning: true,
		});
		await modes.set(parent, { longRunning: false }, owner);
		expect(modes.peek(helper)).toMatchObject({
			yolo: false,
			longRunning: false,
		});
		expect(
			heard.map(([channel, mode]) => [channel, mode.yolo, mode.longRunning]),
		).toEqual([
			[helper, false, false],
			[parent, true, true],
			[helper, true, true],
			[parent, false, true],
			[helper, false, true],
			[parent, false, false],
			[helper, false, false],
		]);
	});

	test("a follower's own modes cannot be set, and only an owner makes one follow", async () => {
		const { modes } = await setup();
		await modes.set(parent, { yolo: true }, owner);
		await modes.follow([helper], parent, owner);
		const refused = modes.set(helper, { yolo: false }, owner);
		await expect(refused).rejects.toThrow(PluginError);
		await expect(refused).rejects.toThrow(
			"follows the modes of Infra; change them there",
		);
		expect(modes.peek(helper).yolo).toBe(true);
		for (const by of [member, { ...owner, principalId: SYSTEM_PRINCIPAL }])
			await expect(modes.follow([thread], parent, by)).rejects.toThrow(
				PluginError,
			);
		expect(modes.peek(thread)).toEqual({ yolo: false, longRunning: false });
	});

	test("when the origin is gone the follower reads off", async () => {
		const { modes, table } = await setup();
		await modes.set(parent, { yolo: true, longRunning: true }, owner);
		await modes.follow([helper], parent, owner);
		expect(modes.peek(helper).yolo).toBe(true);
		table.set(helper, { name: "Infra", alive: false });
		expect(modes.peek(helper)).toMatchObject({
			yolo: false,
			longRunning: false,
			inheritedFrom: { gone: true },
		});
	});

	test("following survives a restart; forget drops it and tells the listeners", async () => {
		const { modes, sql, heard, table } = await setup();
		await modes.set(parent, { yolo: true }, owner);
		await modes.follow([helper], parent, owner);
		const restarted = PgConversationModes.attach(sql, silentLogger());
		await restarted.load();
		restarted.trackOrigins(origins(table));
		expect(restarted.peek(helper)).toMatchObject({
			yolo: true,
			inheritedFrom: { channel: parent },
		});
		heard.length = 0;
		await modes.forget(helper);
		expect(modes.peek(helper)).toEqual({ yolo: false, longRunning: false });
		expect(heard).toEqual([[helper, { yolo: false, longRunning: false }]]);
		// Its own modes can be set again, and a forgotten conversation nobody stored tells no one.
		expect((await modes.set(helper, { longRunning: true }, owner)).yolo).toBe(
			false,
		);
		heard.length = 0;
		await modes.forget(thread);
		expect(heard).toEqual([]);
	});

	test("a conversation that no longer follows keeps its own modes, and setting them clears the follow", async () => {
		const { modes, rows, table } = await setup();
		await modes.set(parent, { yolo: true }, owner);
		await modes.follow([helper], parent, owner);
		// Its agent is gone and the name is another agent's now.
		table.delete(helper);
		expect(modes.peek(helper)).toEqual(
			expect.objectContaining({ yolo: false, longRunning: false }),
		);
		expect(modes.peek(helper).inheritedFrom).toBeUndefined();
		await modes.set(helper, { longRunning: true }, owner);
		expect(rows.get(helper)?.follows).toBeNull();
	});
});
