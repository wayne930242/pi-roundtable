import { afterAll, beforeAll, expect, test } from "bun:test";
import type { SQL } from "bun";
import { PluginError } from "../errors.ts";
import { SYSTEM_PRINCIPAL } from "../identity/principal-store.ts";
import { silentLogger } from "../log.ts";
import type { ChannelKey } from "../sessions.ts";
import type { Speaker } from "../speakers.ts";
import { describeDb, migratedPool } from "../testing/database.ts";
import {
	type AutoApproval,
	type ConversationMode,
	PgConversationModes,
} from "./conversation-modes.ts";

const owner: Speaker = {
	id: "100",
	name: "Ada",
	tier: "owner",
	principalId: "p-ada",
};
const member: Speaker = { ...owner, tier: "member", principalId: "p-bo" };
// Rooms of their own per run, so rows an earlier run left in the shared table do not count.
const run = crypto.randomUUID().slice(0, 8);
const room = `app:agent.guide-${run}` as ChannelKey;
const other = `app:agent.coder-${run}` as ChannelKey;

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("PgConversationModes", () => {
	let sql: SQL;
	const attach = async () => {
		const modes = PgConversationModes.attach(sql, silentLogger());
		await modes.load();
		return modes;
	};

	beforeAll(async () => {
		sql = await migratedPool(...PgConversationModes.migrations);
	});

	afterAll(async () => {
		await sql.close();
	});

	test("a conversation starts with both modes off", async () => {
		const modes = await attach();
		expect(modes.peek(room)).toEqual({ yolo: false, longRunning: false });
	});

	test("a mode an owner set survives a fresh attach, with who changed it and when", async () => {
		const first = await attach();
		const set = await first.set(room, { yolo: true }, owner);
		expect(set).toMatchObject({
			yolo: true,
			longRunning: false,
			changedBy: "p-ada",
		});
		expect(set.changedAt).toBeInstanceOf(Date);
		expect(first.peek(room)).toEqual(set);
		const restarted = await attach();
		expect(restarted.peek(room)).toEqual(set);
		expect(restarted.peek(other)).toEqual({ yolo: false, longRunning: false });
	});

	test("a mode set while the rows are being read is not overwritten by the older row", async () => {
		const stale = `app:agent.late-${run}` as ChannelKey;
		await (await attach()).set(stale, { yolo: false }, owner);
		// The rows are read at once, but handed on only after the release.
		const release = Promise.withResolvers<void>();
		const slow = new Proxy(sql, {
			apply(target, thisArg, args) {
				const result = Reflect.apply(target, thisArg, args);
				const text = String((args[0] as readonly string[])[0]);
				if (!text.includes("SELECT * FROM conversation_modes")) return result;
				return result.then(async (rows: unknown) => {
					await release.promise;
					return rows;
				});
			},
		});
		const modes = PgConversationModes.attach(slow, silentLogger());
		const loading = modes.load();
		await Bun.sleep(50);
		await modes.set(stale, { yolo: true }, owner);
		release.resolve();
		await loading;
		expect(modes.peek(stale).yolo).toBe(true);
	});

	test("a change names only what it sets: the other mode and other conversations stay", async () => {
		const modes = await attach();
		await modes.set(room, { yolo: true, longRunning: true }, owner);
		const after = await modes.set(room, { yolo: false }, owner);
		expect(after).toMatchObject({ yolo: false, longRunning: true });
		expect(modes.peek(other).longRunning).toBe(false);
		expect((await attach()).peek(room)).toMatchObject({
			yolo: false,
			longRunning: true,
		});
	});

	test("only an owner sets a mode, and never the system principal", async () => {
		const modes = await attach();
		const before = modes.peek(other);
		await expect(modes.set(other, { yolo: true }, member)).rejects.toThrow(
			PluginError,
		);
		await expect(
			modes.set(
				other,
				{ yolo: true },
				{ ...owner, principalId: SYSTEM_PRINCIPAL },
			),
		).rejects.toThrow(PluginError);
		await expect(
			modes.set(other, { yolo: true }, { ...owner, tier: "admin" }),
		).rejects.toThrow(PluginError);
		expect(modes.peek(other)).toEqual(before);
		expect((await attach()).peek(other)).toEqual(before);
	});

	test("listeners hear each change until they unsubscribe, and one that throws breaks nothing", async () => {
		const modes = await attach();
		const heard: [ChannelKey, ConversationMode][] = [];
		const off = modes.onChange((channel, mode) => heard.push([channel, mode]));
		modes.onChange(() => {
			throw new Error("listener broke");
		});
		const set = await modes.set(other, { longRunning: true }, owner);
		expect(heard).toEqual([[other, set]]);
		off();
		await modes.set(other, { longRunning: false }, owner);
		expect(heard).toHaveLength(1);
	});

	test("a follower reads its origin's modes after a fresh attach, refuses its own, and forget drops it", async () => {
		const origin = `app:agent.parent-${run}` as ChannelKey;
		const follower = `app:agent.parent-${run}-1` as ChannelKey;
		const modes = await attach();
		await modes.set(origin, { yolo: true }, owner);
		await modes.follow([follower], origin, owner);
		expect(modes.peek(follower)).toMatchObject({
			yolo: true,
			longRunning: false,
			inheritedFrom: { channel: origin },
		});
		await modes.set(origin, { yolo: false, longRunning: true }, owner);
		const restarted = await attach();
		expect(restarted.peek(follower)).toMatchObject({
			yolo: false,
			longRunning: true,
			inheritedFrom: { channel: origin },
		});
		await expect(
			restarted.set(follower, { yolo: true }, owner),
		).rejects.toThrow(PluginError);
		await restarted.forget(follower);
		expect(restarted.peek(follower)).toEqual({
			yolo: false,
			longRunning: false,
		});
		expect((await attach()).peek(follower)).toEqual({
			yolo: false,
			longRunning: false,
		});
	});

	test("an auto-approval reaches its listeners", async () => {
		const modes = await attach();
		const heard: AutoApproval[] = [];
		modes.onAutoApproved((entry) => heard.push(entry));
		const entry: AutoApproval = {
			channel: room,
			tool: "shell",
			action: "git push origin main",
			classes: ["shell.push"],
			principalId: "p-ada",
			at: new Date(),
		};
		modes.autoApproved(entry);
		expect(heard).toEqual([entry]);
	});
});
