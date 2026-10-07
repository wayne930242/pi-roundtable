import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { runMigrations } from "../db/migrations.ts";
import { IdentityError } from "../domain/errors.ts";
import { describeDb } from "../testing/database.ts";
import {
	type ScratchDatabase,
	scratchDatabase,
} from "../testing/fixture-database.ts";
import { identityMigrations } from "./identity-schema.ts";
import { PgPrincipalStore, SYSTEM_PRINCIPAL } from "./principal-store.ts";
import { isPrincipalId, newPrincipalId } from "./ulid.ts";

describe("newPrincipalId", () => {
	test("is p_ and a 26-character ulid, later ids sorting after earlier ones", async () => {
		const first = newPrincipalId();
		await Bun.sleep(2);
		const second = newPrincipalId();
		expect(first).toMatch(/^p_[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(second > first).toBe(true);
		expect(isPrincipalId(first)).toBe(true);
		expect(isPrincipalId("966666600000000001")).toBe(false);
	});
});

describeDb("PgPrincipalStore", () => {
	let db: ScratchDatabase;
	let store: PgPrincipalStore;
	beforeAll(async () => {
		db = await scratchDatabase();
		await runMigrations(db.sql, [
			{ name: "identity", migrations: identityMigrations({ owners: [] }) },
		]);
		store = await PgPrincipalStore.attach(db.sql);
	});
	afterAll(async () => {
		await db.drop();
	});

	test("creates a principal with a new p_ id, or the id it is given, and reads it back", async () => {
		const made = await store.create({ displayName: "Ada", pronouns: "they" });
		expect(made.id).toMatch(/^p_/);
		expect(await store.get(made.id)).toMatchObject({
			id: made.id,
			displayName: "Ada",
			pronouns: "they",
			disabled: false,
		});
		const legacy = await store.create({
			id: "966666600000000021",
			displayName: "Kai",
		});
		expect(legacy.id).toBe("966666600000000021");
		expect(legacy.pronouns).toBeUndefined();
		expect(await store.get("nobody")).toBeUndefined();
		expect(
			store.create({ id: "966666600000000021", displayName: "Again" }),
		).rejects.toThrow(IdentityError);
	});

	test("the system principal cannot be created", () => {
		expect(
			store.create({ id: SYSTEM_PRINCIPAL, displayName: "System" }),
		).rejects.toThrow(IdentityError);
	});

	test("an identity links to one principal; linking it to another is refused, unlinking frees it", async () => {
		const a = await store.create({ displayName: "A" });
		const b = await store.create({ displayName: "B" });
		await store.link(
			a.id,
			{ provider: "discord", subject: "966666600000000031" },
			"cli",
		);
		// Linking again to the same principal is a no-op.
		await store.link(
			a.id,
			{ provider: "discord", subject: "966666600000000031" },
			"cli",
		);
		expect(await store.identity("discord", "966666600000000031")).toMatchObject(
			{ principalId: a.id, source: "cli" },
		);
		expect(
			store.link(
				b.id,
				{ provider: "discord", subject: "966666600000000031" },
				"cli",
			),
		).rejects.toThrow(IdentityError);
		await store.link(
			a.id,
			{ provider: "token", subject: "remote-mcp" },
			"config",
		);
		expect(
			(await store.identitiesOf(a.id)).map(
				(link) => `${link.provider}:${link.subject}`,
			),
		).toEqual(["discord:966666600000000031", "token:remote-mcp"]);
		expect(
			(await store.linksFrom("config")).map((link) => link.subject),
		).toContain("remote-mcp");
		expect(await store.unlink("discord", "966666600000000031")).toBe(true);
		expect(await store.unlink("discord", "966666600000000031")).toBe(false);
		await store.link(
			b.id,
			{ provider: "discord", subject: "966666600000000031" },
			"cli",
		);
		expect(
			(await store.identity("discord", "966666600000000031"))?.principalId,
		).toBe(b.id);
		expect(
			store.link(
				"nobody",
				{ provider: "discord", subject: "966666600000000032" },
				"cli",
			),
		).rejects.toThrow(IdentityError);
	});

	test("roles are granted and revoked by source: a CLI grant outlives the config's revoke", async () => {
		const p = await store.create({ displayName: "P" });
		await store.grant(p.id, "owner", "config");
		await store.grant(p.id, "admin", "config");
		await store.grant(p.id, "admin", "cli");
		expect(
			(await store.rolesOf(p.id)).map(
				(grant) => `${grant.role}/${grant.source}`,
			),
		).toEqual(["admin/cli", "owner/config"]);
		await store.revoke(p.id, "owner", "config");
		await store.revoke(p.id, "admin", "config");
		expect((await store.rolesOf(p.id)).map((grant) => grant.role)).toEqual([
			"admin",
		]);
		expect(await store.holders("admin")).toContainEqual({
			principalId: p.id,
			source: "cli",
		});
		await store.revoke(p.id, "admin");
		expect(await store.rolesOf(p.id)).toEqual([]);
		expect(
			(await store.holders("admin")).map((holder) => holder.principalId),
		).not.toContain(p.id);
	});

	test("disable and enable switch a principal off and on; touch records when it was seen and at which tier", async () => {
		const p = await store.create({ displayName: "Q" });
		await store.disable(p.id);
		expect((await store.get(p.id))?.disabled).toBe(true);
		await store.enable(p.id);
		expect((await store.get(p.id))?.disabled).toBe(false);
		expect((await store.get(p.id))?.lastSeenAt).toBeUndefined();
		await store.touch(p.id, "member");
		const seen = await store.get(p.id);
		expect(seen?.lastTier).toBe("member");
		expect(seen?.lastSeenAt).toBeInstanceOf(Date);
		const at = new Date("2026-09-01T09:00:00Z");
		await store.touch(p.id, "admin", at);
		expect(await store.get(p.id)).toMatchObject({
			lastTier: "admin",
			lastSeenAt: at,
		});
	});

	test("update changes the name and pronouns, and list returns every principal", async () => {
		const p = await store.create({ displayName: "R" });
		await store.update(p.id, { displayName: "Riley", pronouns: "he" });
		expect(await store.get(p.id)).toMatchObject({
			displayName: "Riley",
			pronouns: "he",
		});
		expect((await store.list()).map((row) => row.id)).toContain(p.id);
	});
});

describeDb(
	"PgPrincipalStore under concurrent first contact and linking",
	() => {
		let db: ScratchDatabase;
		beforeAll(async () => {
			db = await scratchDatabase();
			await runMigrations(db.sql, [
				{ name: "identity", migrations: identityMigrations({ owners: [] }) },
			]);
		});
		afterAll(async () => {
			await db.drop();
		});

		/** The sessions of the database now waiting on a lock. */
		const waiting = async (sql: SQL) =>
			Number(
				(
					await sql`
					SELECT count(*) AS n FROM pg_stat_activity
					WHERE datname = current_database() AND wait_event_type = 'Lock'`
				)[0]?.n,
			);

		test("a claim and a link of the same identity at once do not deadlock: one waits for the other", async () => {
			const id = "966666600000000031";
			await db.sql`INSERT INTO principals (id, display_name, claimable) VALUES (${id}, 'Kai', true)`;
			const store = await PgPrincipalStore.attach(db.sql);
			const holder = new SQL(db.url, { max: 1 });
			const watcher = new SQL(db.url, { max: 1 });
			try {
				// Another session holds the principal's row, so both writers queue behind it in an order
				// that deadlocked when the link took no lock: the claim on the row, the link on the claim.
				let release = () => {};
				const released = new Promise<void>((resolve) => {
					release = resolve;
				});
				let held = () => {};
				const holding = new Promise<void>((resolve) => {
					held = resolve;
				});
				const hold = holder.begin(async (tx) => {
					await tx`SELECT 1 FROM principals WHERE id = ${id} FOR NO KEY UPDATE`;
					held();
					await released;
				});
				await holding;
				const ref = { provider: "discord", subject: id };
				const claim = store.claim(id, ref);
				while ((await waiting(watcher)) < 1) await Bun.sleep(10);
				const link = store.link(id, ref, "cli");
				// Let the link go as far as it can before the row is released.
				await Bun.sleep(200);
				release();
				await hold;
				const [claimed, linked] = await Promise.allSettled([claim, link]);
				expect(claimed).toMatchObject({
					status: "fulfilled",
					value: { principalId: id, source: "legacy" },
				});
				expect(linked).toMatchObject({
					status: "fulfilled",
					value: { principalId: id },
				});
			} finally {
				await holder.close();
				await watcher.close();
			}
		});
	},
);
