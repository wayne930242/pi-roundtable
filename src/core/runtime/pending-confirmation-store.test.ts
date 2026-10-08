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

	test("the principal of that speaker comes back with them; 0.8's held actions name none", async () => {
		const theirs = { ...held, speakerId: "7", principalId: "p_7" };
		await store.save("discord:6", theirs);
		expect(await store.load("discord:6")).toEqual(theirs);
		const admin = new SQL(testDatabaseUrl);
		try {
			// 0.8's save, which knows the speaker and no principal.
			await admin`
				UPDATE held_actions SET principal_id = NULL WHERE channel_key = 'discord:6'`;
		} finally {
			await admin.close();
		}
		expect(await store.load("discord:6")).toEqual({ ...held, speakerId: "7" });
		await store.save("discord:6", undefined);
	});

	test("a principal does not carry over to actions 0.8, which keeps the column as it was, held over theirs", async () => {
		await store.save("discord:7", {
			...held,
			speakerId: "A",
			principalId: "pA",
		});
		const admin = new SQL(testDatabaseUrl);
		const later = { ...held, heldAt: new Date("2026-09-28T01:00:00Z") };
		try {
			// v0.8.0's save, which knows the speaker and leaves principal_id as it was.
			await admin`
				INSERT INTO held_actions
					(channel_key, selection_id, held_at, calls, speaker_id, speaker_held_at)
				VALUES ('discord:7', ${later.selectionId}, ${later.heldAt},
					${JSON.stringify(later.calls)}, 'B', ${later.heldAt})
				ON CONFLICT (channel_key) DO UPDATE SET selection_id = EXCLUDED.selection_id,
					held_at = EXCLUDED.held_at, calls = EXCLUDED.calls,
					speaker_id = EXCLUDED.speaker_id, speaker_held_at = EXCLUDED.speaker_held_at`;
		} finally {
			await admin.close();
		}
		// B's, by their id: A's principal no longer names who approves them.
		expect(await store.load("discord:7")).toEqual({ ...later, speakerId: "B" });
		await store.save("discord:7", undefined);
	});

	test("a speaker does not carry over to actions 0.7, which keeps the column as it was, held over theirs", async () => {
		await store.save("discord:5", { ...held, speakerId: "7" });
		const admin = new SQL(testDatabaseUrl);
		const later = { ...held, heldAt: new Date("2026-09-28T01:00:00Z") };
		try {
			// 0.7.19's save, which knows no speaker and leaves speaker_id as it was.
			await admin`
				INSERT INTO held_actions (channel_key, selection_id, held_at, calls)
				VALUES ('discord:5', ${later.selectionId}, ${later.heldAt},
					${JSON.stringify(later.calls)})
				ON CONFLICT (channel_key) DO UPDATE SET selection_id = EXCLUDED.selection_id,
					held_at = EXCLUDED.held_at, calls = EXCLUDED.calls`;
		} finally {
			await admin.close();
		}
		// Only the owner may approve them.
		expect(await store.load("discord:5")).toEqual(later);
		await store.save("discord:5", undefined);
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
