import { expect, test } from "bun:test";
import type { ChannelKey } from "./core/domain/conversation.ts";
import { IDENTITY } from "./core/services.ts";
import type { Speaker } from "./core/speakers.ts";
import { describeDb } from "./core/testing/database.ts";
import { scratchDatabase } from "./core/testing/fixture-database.ts";
import {
	CAPTURE_MEMBER,
	CAPTURE_OWNER,
	CAPTURE_OWNER_SPEAKER,
	type CaptureHost,
	captureHost,
} from "./core/testing/prompt-capture.ts";
import { hasWebAccess } from "./core/testing/test-host.ts";

/** What the model was told in a private conversation of the speaker's, as one searchable text. */
async function privatePrompt(
	host: CaptureHost,
	speaker: Speaker,
	channel: ChannelKey,
): Promise<string> {
	const seen = await host.capture(async () => {
		const result = await host.context.turns.run({
			channel,
			kind: "chat",
			text: "Hello.",
			speaker,
			conversation: { visibility: "private" },
		});
		if (!result.ok)
			throw new Error(`the turn failed: ${JSON.stringify(result)}`);
	});
	return JSON.stringify(seen);
}

// A 0.8.0 single-owner database (src/core/testing/fixtures/db-0.8.0.sql) booted by this version,
// whose memory rows are keyed by 0.8's speaker ids. Runs against a real PostgreSQL, only when
// ROUNDTABLE_TEST_DATABASE_URL is set and the delegation worker can load.
(hasWebAccess() ? describeDb : describeDb.skip)(
	"memory after an upgrade from 0.8",
	() => {
		test("the primary owner's 0.8 memory loads in their own conversation and in a remote turn of theirs, and a member reads only theirs", async () => {
			const db = await scratchDatabase("0.8.0");
			const before = await db.sql`
				SELECT id, speaker_id, fact FROM owner_memory ORDER BY id`;
			const host = await captureHost(false, "access", db.url);
			try {
				const id = crypto.randomUUID();
				const own = await privatePrompt(
					host,
					CAPTURE_OWNER_SPEAKER,
					`fake:web-${id}`,
				);
				// As remote-mcp starts a turn for the principal its token stands for.
				const remote = await privatePrompt(
					host,
					await host.context.services
						.get(IDENTITY)
						.speakerFor(CAPTURE_OWNER.id),
					`fake:mcp-${id}`,
				);
				const member = await privatePrompt(
					host,
					CAPTURE_MEMBER,
					`fake:member-${id}`,
				);
				for (const prompt of [own, remote]) {
					expect(prompt).toContain("## Owner memory");
					expect(prompt).toContain("Ada drinks oolong tea");
					expect(prompt).not.toContain("Kai studies");
				}
				expect(member).toContain("Kai studies for the finals");
				expect(member).not.toContain("Ada drinks");
				// Booting changed no memory row: each is still keyed by its 0.8 speaker id.
				expect(
					await db.sql`SELECT id, speaker_id, fact FROM owner_memory ORDER BY id`,
				).toEqual(before);
			} finally {
				await host.stop();
				await db.drop();
			}
		}, 60_000);
	},
);
