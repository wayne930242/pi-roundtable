import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import type { PendingConfirmation } from "../domain/conversation.ts";
import {
	describeDb,
	openTestStore,
	type TestStore,
	testDatabaseUrl,
} from "../testing/database.ts";
import { PendingConfirmationStore } from "./pending-confirmation-store.ts";

const held: PendingConfirmation = {
	selectionId: "workspace",
	heldAt: new Date("2026-09-27T01:00:00Z"),
	calls: [
		{
			tool: "google-send-gmail-message",
			input: '{"subject":"hi","to":"a@b.c"}',
			action: "send an email to a@b.c",
		},
	],
};

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("PendingConfirmationStore", () => {
	let store: TestStore<PendingConfirmationStore>;

	beforeAll(async () => {
		const admin = new SQL(testDatabaseUrl);
		await admin`DROP TABLE IF EXISTS held_actions`;
		await admin.close();
		store = await openTestStore(PendingConfirmationStore);
	});

	afterAll(async () => {
		await store.close();
	});

	test("held actions survive a restart, are replaced, and are cleared", async () => {
		expect(await store.load("discord:1")).toBeUndefined();
		await store.save("discord:1", held);
		expect(await store.load("discord:1")).toEqual(held);

		const other = { ...held, calls: [] };
		await store.save("discord:1", other);
		expect(await store.load("discord:1")).toEqual(other);
		expect(await store.load("discord:2")).toBeUndefined();

		await store.save("discord:1", undefined);
		expect(await store.load("discord:1")).toBeUndefined();
	});

	test("the speaker whose turn held the actions comes back with them", async () => {
		await store.save("discord:4", { ...held, speakerId: "7" });
		expect(await store.load("discord:4")).toEqual({ ...held, speakerId: "7" });
		await store.save("discord:4", held);
		expect(await store.load("discord:4")).toEqual(held);
		await store.save("discord:4", undefined);
	});

	test("the selection id is stored as given, in the held_actions table", async () => {
		await store.save("discord:3", { ...held, selectionId: "tools:web" });
		const admin = new SQL(testDatabaseUrl);
		try {
			const rows = await admin`
				SELECT selection_id FROM held_actions WHERE channel_key = 'discord:3'`;
			expect(rows.map((r: { selection_id: string }) => r.selection_id)).toEqual(
				["tools:web"],
			);
		} finally {
			await admin.close();
		}
		expect((await store.load("discord:3"))?.selectionId).toBe("tools:web");
		await store.save("discord:3", undefined);
	});
});
