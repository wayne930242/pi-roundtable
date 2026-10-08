import { expect, test } from "bun:test";
import { SQL } from "bun";
import {
	describeDb,
	silentLogger,
	testDatabaseUrl,
} from "pi-roundtable/testing";
import { restHandler } from "./rest.ts";
import { identity, testChat } from "./testing/fakes.ts";
import { TicketBook } from "./tickets.ts";
import { PgNotices } from "./notices.ts";

describeDb("webchat's persistent private inbox", () => {
	test("notice text, frames, retention and REST-sized pages are bounded", async () => {
		const sql = new SQL(testDatabaseUrl);
		await PgNotices.migration.up(sql);
		const principal = `notice-bound-${crypto.randomUUID()}`;
		const other = `notice-other-${crypto.randomUUID()}`;
		try {
			const notices = new PgNotices(sql);
			const first = await notices.add(principal, "\u0001".repeat(50_000));
			expect(first.text.length).toBeLessThanOrEqual(4096);
			expect(first.text.endsWith("…")).toBe(true);
			const bytes = Buffer.byteLength(
				JSON.stringify({ type: "notice", notice: first }),
			);
			expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
			const small = new PgNotices(sql, {
				messageChars: 1000,
				maxBufferedBytes: 512,
			});
			const tiny = await small.add(other, '\u0001😀\n\\"'.repeat(1000));
			expect(
				Buffer.byteLength(JSON.stringify({ type: "notice", notice: tiny })),
			).toBeLessThanOrEqual(512);
			expect(tiny.text.endsWith("…")).toBe(true);
			expect(() => new PgNotices(sql, { maxBufferedBytes: 128 })).toThrow(
				"maxBufferedBytes",
			);
			await Promise.all(
				Array.from({ length: 105 }, (_, i) =>
					notices.add(principal, `new ${i}`),
				),
			);
			const rows = await notices.list(principal, 500);
			expect(rows).toHaveLength(100);
			expect(rows.some((row) => row.id === first.id)).toBe(false);
			expect(await notices.read(principal, first.id)).toBeUndefined();
			expect(
				await notices.list(principal, Number.POSITIVE_INFINITY),
			).toHaveLength(50);
			expect(await notices.list(other)).toHaveLength(1);
			const { chat, connect } = testChat({
				verifier: async () => identity("actor", ["User"]),
			});
			const socket = connect("actor", ["User"], principal);
			try {
				const rest = restHandler({
					chat,
					notices,
					tickets: new TicketBook({ ttlMs: 30_000 }),
					path: "/chat",
					origins: "any",
					logger: silentLogger(),
				});
				const response = await rest(
					new Request("http://localhost/chat/notices?limit=500", {
						headers: { authorization: "Bearer valid" },
					}),
				);
				expect(response.status).toBe(200);
				expect((await response.json()).notices).toHaveLength(100);
			} finally {
				chat.closed(socket);
			}
			expect(
				Buffer.byteLength(JSON.stringify({ notices: rows })),
			).toBeLessThanOrEqual(100 * (6 * 4096 + 256) + 32);
		} finally {
			await sql`DELETE FROM webchat_notices WHERE principal_id IN (${principal}, ${other})`;
			await sql.close();
		}
	});

	test("notices survive reattach and another principal cannot list or mark them read", async () => {
		const sql = new SQL(testDatabaseUrl);
		await PgNotices.migration.up(sql);
		const a = `notice-a-${crypto.randomUUID()}`;
		const b = `notice-b-${crypto.randomUUID()}`;
		try {
			const notices = new PgNotices(sql);
			const entry = await notices.add(a, "Private reminder");
			expect(entry.readAt).toBeNull();
			expect(await notices.list(b)).toEqual([]);
			expect(await notices.read(b, entry.id)).toBeUndefined();
			const reopened = new PgNotices(sql);
			expect(await reopened.list(a)).toEqual([entry]);
			const read = await reopened.read(a, entry.id);
			expect(read?.readAt).not.toBeNull();
			expect(await reopened.read(a, entry.id)).toEqual(read);
		} finally {
			await sql`DELETE FROM webchat_notices WHERE principal_id IN (${a}, ${b})`;
			await sql.close();
		}
	});
});
