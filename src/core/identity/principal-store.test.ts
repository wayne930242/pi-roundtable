import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
			{ name: "identity", migrations: identityMigrations([]) },
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
		await store.link(a.id, { provider: "discord", subject: "966666600000000031" }, "cli");
		// Linking again to the same principal is a no-op.
		await store.link(a.id, { provider: "discord", subject: "966666600000000031" }, "cli");
		expect(
			await store.identity("discord", "966666600000000031"),
		).toMatchObject({ principalId: a.id, source: "cli" });
		expect(
			store.link(b.id, { provider: "discord", subject: "966666600000000031" }, "cli"),
		).rejects.toThrow(IdentityError);
		await store.link(a.id, { provider: "token", subject: "remote-mcp" }, "config");
		expect(
			(await store.identitiesOf(a.id)).map((link) => `${link.provider}:${link.subject}`),
		).toEqual(["discord:966666600000000031", "token:remote-mcp"]);
		expect(await store.unlink("discord", "966666600000000031")).toBe(true);
		expect(await store.unlink("discord", "966666600000000031")).toBe(false);
		await store.link(b.id, { provider: "discord", subject: "966666600000000031" }, "cli");
		expect(
			(await store.identity("discord", "966666600000000031"))?.principalId,
		).toBe(b.id);
		expect(
			store.link("nobody", { provider: "discord", subject: "966666600000000032" }, "cli"),
		).rejects.toThrow(IdentityError);
	});

	test("roles are granted and revoked by source: a CLI grant outlives the config's revoke", async () => {
		const p = await store.create({ displayName: "P" });
		await store.grant(p.id, "owner", "config");
		await store.grant(p.id, "admin", "config");
		await store.grant(p.id, "admin", "cli");
		expect(
			(await store.rolesOf(p.id)).map((grant) => `${grant.role}/${grant.source}`),
		).toEqual(["admin/cli", "owner/config"]);
		await store.revoke(p.id, "owner", "config");
		await store.revoke(p.id, "admin", "config");
		expect((await store.rolesOf(p.id)).map((grant) => grant.role)).toEqual([
			"admin",
		]);
		await store.revoke(p.id, "admin");
		expect(await store.rolesOf(p.id)).toEqual([]);
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
