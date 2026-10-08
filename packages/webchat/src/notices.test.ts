import { expect, test } from "bun:test";
import { SQL } from "bun";
import type { IdentityService } from "pi-roundtable";
import {
	describeDb,
	partial,
	silentLogger,
	testDatabaseUrl,
} from "pi-roundtable/testing";
import { webDirectChannel } from "./direct-channel.ts";
import { PgNotices } from "./notices.ts";
import { restHandler } from "./rest.ts";
import { identity, testChat } from "./testing/fakes.ts";
import { TicketBook } from "./tickets.ts";

describeDb("webchat's persistent private inbox", () => {
	test("two surfaces isolate inboxes, read/cursors, retention and offline knows", async () => {
		const sql = new SQL(testDatabaseUrl);
		await PgNotices.migration.up(sql);
		const principalId = `notice-surfaces-${crypto.randomUUID()}`;
		const service = partial<IdentityService>({
			principal: async () => ({
				id: principalId,
				displayName: "Ada",
				disabled: false,
				createdAt: new Date(),
				lastSeenAt: new Date(),
			}),
			identities: async () => [
				{
					provider: "oidc:issuer",
					subject: "ada",
					principalId,
					source: "jit",
					linkedAt: new Date(),
				},
			],
		});
		try {
			const a = new PgNotices(sql, { surface: "a" });
			const b = new PgNotices(sql, { surface: "b" });
			const first = await a.add(principalId, "A only");
			const second = await b.add(principalId, "B only");
			expect(await a.list(principalId)).toEqual([first]);
			expect(await b.list(principalId)).toEqual([second]);
			expect(await b.read(principalId, first.id)).toBeUndefined();
			expect(await a.read(principalId, second.id)).toBeUndefined();
			expect(await b.list(principalId, 50, first.id)).toEqual([]);
			await Promise.all(
				Array.from({ length: 105 }, () => a.add(principalId, "A newest")),
			);
			expect(await a.list(principalId, 500)).toHaveLength(100);
			expect(await b.list(principalId)).toEqual([second]);
			const chatA = testChat({ surface: "a" });
			const chatB = testChat({ surface: "b", registry: () => chatA.registry });
			const provider = (chat: typeof chatA.chat, notices: PgNotices) =>
				webDirectChannel({
					chat,
					notices,
					identity: () => service,
					registry: () => chatA.registry,
				});
			const directA = provider(chatA.chat, a);
			const directB = provider(chatB.chat, b);
			if (!directA.knows || !directB.knows || !directB.deliver)
				throw new Error("missing inbox methods");
			// A generic OIDC link is not proof this principal ever used either surface.
			expect(await directA.knows(principalId)).toBe(false);
			expect(await directB.knows(principalId)).toBe(false);
			await chatA.registry.register({
				key: "a:private",
				kind: "helper",
				visibility: "private",
				principalId,
			});
			expect(await directA.knows(principalId)).toBe(true);
			expect(await directB.knows(principalId)).toBe(false);
			await expect(
				directB.deliver(principalId, "not admitted here"),
			).rejects.toThrow("forbidden");
			await chatA.registry.register({
				key: "b:shared",
				kind: "helper",
				visibility: "shared",
				principalId,
			});
			expect(await directB.knows(principalId)).toBe(false);
			await chatA.registry.register({
				key: "b:private",
				kind: "helper",
				visibility: "private",
				principalId,
			});
			expect(await directB.knows(principalId)).toBe(true);
			const socketA = chatA.connect("actor-a", ["User"], principalId);
			const socketB = chatB.connect("actor-b", ["User"], principalId);
			try {
				if (!directA.deliver) throw new Error("missing delivery");
				await directA.deliver(principalId, "live A only");
				expect(socketA.frames.at(-1)).toMatchObject({
					type: "notice",
					notice: { text: "live A only" },
				});
				expect(socketB.frames.some((frame) => frame.type === "notice")).toBe(
					false,
				);
				expect(await b.list(principalId)).toEqual([second]);
			} finally {
				chatA.chat.closed(socketA);
				chatB.chat.closed(socketB);
			}
		} finally {
			await sql`DELETE FROM webchat_notices WHERE principal_id = ${principalId}`;
			await sql.close();
		}
	});

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
				expect(await response.json()).toMatchObject({ notices: rows });
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
