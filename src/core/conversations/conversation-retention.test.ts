import { describe, expect, test } from "bun:test";
import type { ChannelKey } from "../domain/conversation.ts";
import { silentLogger } from "../log.ts";
import type {
	ConversationRecord,
	ConversationRegistry,
} from "./conversation-registry.ts";
import {
	conversationRetentionService,
	sweepConversations,
} from "./conversation-retention.ts";

const DAY = 24 * 60 * 60_000;
const NOW = new Date("2026-10-29T12:00:00Z");

const record = (
	key: ChannelKey,
	kind: string,
	idleDays: number,
): ConversationRecord => ({
	key,
	surface: key.slice(0, key.indexOf(":")),
	kind,
	visibility: "shared",
	createdAt: new Date(NOW.getTime() - 400 * DAY),
	lastActiveAt: new Date(NOW.getTime() - idleDays * DAY),
});

/** A registry over these records that forgets what `remove` is told to. */
function registryOf(records: ConversationRecord[]): ConversationRegistry & {
	kept(): string[];
} {
	const held = new Map(records.map((r) => [r.key, r]));
	return {
		register: async () => {
			throw new Error("not used");
		},
		get: async (key) => held.get(key),
		list: async () => [...held.values()],
		adopt: async () => undefined,
		setTitle: async () => undefined,
		remove: async (key) => held.delete(key),
		kept: () => [...held.keys()],
	};
}

function setup(
	records: ConversationRecord[],
	outcome: (key: ChannelKey) => "deleted" | "busy" | Error = () => "deleted",
	keepDays: Record<string, number> = { support: 365 },
) {
	const registry = registryOf(records);
	const asked: ChannelKey[] = [];
	const warnings: unknown[] = [];
	return {
		registry,
		asked,
		warnings,
		options: {
			registry,
			keepDays,
			now: () => NOW,
			logger: {
				...silentLogger(),
				warn: (fields: unknown) => void warnings.push(fields),
			},
			conversations: {
				deleteConversation: async (key: ChannelKey) => {
					asked.push(key);
					const result = outcome(key);
					if (result instanceof Error) throw result;
					return result;
				},
			},
		},
	};
}

describe("the conversation retention sweep", () => {
	test("an idle conversation of a configured kind past its keepDays is deleted and forgotten", async () => {
		const run = setup([
			record("web:old", "support", 366),
			record("web:fresh", "support", 364),
		]);
		expect(await sweepConversations(run.options)).toEqual({
			deleted: 1,
			busy: 0,
			failed: 0,
			kept: 0,
		});
		expect(run.asked).toEqual(["web:old"]);
		expect(run.registry.kept()).toEqual(["web:fresh"]);
	});

	test("kinds nobody configured are untouched, however idle", async () => {
		const run = setup([
			record("web:a", "study", 4_000),
			record("web:b", "support", 400),
		]);
		await sweepConversations(run.options);
		expect(run.asked).toEqual(["web:b"]);
		expect(run.registry.kept()).toEqual(["web:a"]);
	});

	test("each kind has its own days", async () => {
		const run = setup(
			[record("web:a", "chat", 31), record("web:b", "support", 31)],
			() => "deleted",
			{ chat: 30, support: 90 },
		);
		await sweepConversations(run.options);
		expect(run.asked).toEqual(["web:a"]);
	});

	test("a busy conversation is skipped, kept, and tried again at the next sweep", async () => {
		let busy = true;
		const run = setup([record("web:old", "support", 500)], () =>
			busy ? "busy" : "deleted",
		);
		expect(await sweepConversations(run.options)).toMatchObject({
			deleted: 0,
			busy: 1,
		});
		expect(run.registry.kept()).toEqual(["web:old"]);
		busy = false;
		expect(await sweepConversations(run.options)).toMatchObject({
			deleted: 1,
			busy: 0,
		});
		expect(run.registry.kept()).toEqual([]);
	});

	test("a conversation whose deletion throws is logged and kept, and the others are still swept", async () => {
		const run = setup(
			[record("web:bad", "support", 500), record("web:good", "support", 500)],
			(key) => (key === "web:bad" ? new Error("no claim") : "deleted"),
		);
		expect(await sweepConversations(run.options)).toEqual({
			deleted: 1,
			busy: 0,
			failed: 1,
			kept: 0,
		});
		expect(run.registry.kept()).toEqual(["web:bad"]);
		expect(run.warnings).toMatchObject([
			{ channel: "web:bad", kind: "support" },
		]);
	});

	test("a conversation the host's keep wants survives its days and is asked again at the next sweep", async () => {
		const wanted = new Set(["web:open"]);
		const run = setup([
			record("web:open", "support", 500),
			record("web:closed", "support", 500),
			record("web:fresh", "support", 1),
		]);
		const seen: string[] = [];
		const options = {
			...run.options,
			keep: async (one: ConversationRecord) => {
				seen.push(one.key);
				return wanted.has(one.key);
			},
		};
		expect(await sweepConversations(options)).toEqual({
			deleted: 1,
			busy: 0,
			failed: 0,
			kept: 1,
		});
		// Only a conversation past its days is asked about.
		expect(seen).toEqual(["web:open", "web:closed"]);
		expect(run.asked).toEqual(["web:closed"]);
		expect(run.registry.kept()).toEqual(["web:open", "web:fresh"]);
		wanted.clear();
		expect(await sweepConversations(options)).toMatchObject({
			deleted: 1,
			kept: 0,
		});
		expect(run.registry.kept()).toEqual(["web:fresh"]);
	});

	test("a keep that throws keeps the conversation for this sweep and is logged", async () => {
		const run = setup([
			record("web:a", "support", 500),
			record("web:b", "support", 500),
		]);
		const options = {
			...run.options,
			keep: (one: ConversationRecord) => {
				if (one.key === "web:a") throw new Error("ticket lookup down");
				return false;
			},
		};
		expect(await sweepConversations(options)).toEqual({
			deleted: 1,
			busy: 0,
			failed: 1,
			kept: 0,
		});
		expect(run.registry.kept()).toEqual(["web:a"]);
		expect(run.warnings).toMatchObject([{ channel: "web:a" }]);
	});

	test("the service sweeps at start and stops cleanly", async () => {
		const run = setup([record("web:old", "support", 500)]);
		const service = conversationRetentionService(run.options);
		await service.start?.();
		expect(run.asked).toEqual(["web:old"]);
		await service.stop?.();
	});
});
