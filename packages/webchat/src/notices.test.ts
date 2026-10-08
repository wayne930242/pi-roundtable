import { expect, test } from "bun:test";
import { SQL } from "bun";
import { describeDb, testDatabaseUrl } from "pi-roundtable/testing";
import { PgNotices } from "./notices.ts";

describeDb("webchat's persistent private inbox", () => {
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
