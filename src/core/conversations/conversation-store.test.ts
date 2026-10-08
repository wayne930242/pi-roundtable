import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import {
	describeDb,
	openTestStore,
	type TestStore,
	testDatabaseUrl,
} from "../testing/database.ts";
import { PgConversationRegistry } from "./conversation-store.ts";

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("PgConversationRegistry", () => {
	let registry: TestStore<PgConversationRegistry>;

	beforeAll(async () => {
		const admin = new SQL(testDatabaseUrl);
		await admin`DROP TABLE IF EXISTS conversations`;
		await admin.close();
		registry = await openTestStore(PgConversationRegistry);
	});

	afterAll(async () => {
		await registry.close();
	});

	test("the first turn records a conversation; later ones only mark it active", async () => {
		const first = await registry.register({
			key: "web:c1",
			kind: "study",
			visibility: "private",
			principalId: "oidc:aXNz:ada",
			title: "Algebra",
		});
		expect(first).toMatchObject({
			key: "web:c1",
			surface: "web",
			kind: "study",
			visibility: "private",
			principalId: "oidc:aXNz:ada",
			title: "Algebra",
		});
		expect(first.createdAt).toBeInstanceOf(Date);
		await Bun.sleep(5);
		// What the first turn fixed stays: the kind, the visibility, the principal, and the title.
		const again = await registry.register({
			key: "web:c1",
			kind: "other",
			visibility: "shared",
			principalId: "oidc:aXNz:bo",
			title: "Changed",
		});
		expect(again).toMatchObject({
			kind: "study",
			visibility: "private",
			principalId: "oidc:aXNz:ada",
			title: "Algebra",
		});
		expect(again.createdAt).toEqual(first.createdAt);
		expect(again.lastActiveAt.getTime()).toBeGreaterThan(
			first.lastActiveAt.getTime(),
		);
		expect(await registry.get("web:c1")).toEqual(again);
	});

	test("a shared conversation needs no principal, and an unknown key reads as undefined", async () => {
		const shared = await registry.register({
			key: "fake:study-room",
			kind: "study",
			visibility: "shared",
		});
		expect(shared.principalId).toBeUndefined();
		expect(shared.title).toBeUndefined();
		expect(await registry.get("web:none")).toBeUndefined();
	});

	test("a conversation recorded shared with no principal, as 0.8 recorded a turn run without one, becomes private to the first turn that asks for it", async () => {
		const first = await registry.register({
			key: "mcp:0-8-session",
			kind: "remote",
			visibility: "shared",
		});
		const adopted = await registry.register({
			key: "mcp:0-8-session",
			kind: "remote",
			visibility: "private",
			principalId: "ada",
		});
		expect(adopted).toMatchObject({
			kind: "remote",
			visibility: "private",
			principalId: "ada",
		});
		expect(adopted.createdAt).toEqual(first.createdAt);
		// Then it is Ada's: no later turn, private or shared, takes it from her.
		for (const visibility of ["private", "shared"] as const)
			expect(
				await registry.register({
					key: "mcp:0-8-session",
					kind: "remote",
					visibility,
					principalId: "bo",
				}),
			).toMatchObject({ visibility: "private", principalId: "ada" });
		// A shared turn leaves a shared conversation shared.
		await registry.register({
			key: "fake:room",
			kind: "study",
			visibility: "shared",
		});
		expect(
			await registry.register({
				key: "fake:room",
				kind: "study",
				visibility: "shared",
			}),
		).toMatchObject({ visibility: "shared" });
		expect((await registry.get("fake:room"))?.principalId).toBeUndefined();
	});

	test("a shared conversation that names a principal is never made private to another", async () => {
		await registry.register({
			key: "fake:named",
			kind: "study",
			visibility: "shared",
			principalId: "ada",
		});
		expect(
			await registry.register({
				key: "fake:named",
				kind: "study",
				visibility: "private",
				principalId: "bo",
			}),
		).toMatchObject({ visibility: "shared", principalId: "ada" });
	});

	test("list gives a principal's conversations, or every one, the most recently active first", async () => {
		await registry.register({
			key: "web:c2",
			kind: "study",
			visibility: "private",
			principalId: "oidc:aXNz:ada",
		});
		await Bun.sleep(5);
		await registry.register({
			key: "web:c3",
			kind: "study",
			visibility: "private",
			principalId: "oidc:aXNz:bo",
		});
		await Bun.sleep(5);
		await registry.register({
			key: "web:c1",
			kind: "study",
			visibility: "private",
		});
		expect(
			(await registry.list({ principal: "oidc:aXNz:ada" })).map((c) => c.key),
		).toEqual(["web:c1", "web:c2"]);
		expect(
			(await registry.list({ principal: "oidc:aXNz:bo" })).map((c) => c.key),
		).toEqual(["web:c3"]);
		const every = (await registry.list()).map((c) => c.key);
		expect(every.slice(0, 3)).toEqual(["web:c1", "web:c3", "web:c2"]);
		expect(every).toContain("fake:study-room");
	});

	test("setTitle names a conversation, and clears the name with undefined", async () => {
		expect((await registry.setTitle("web:c2", "Groups"))?.title).toBe("Groups");
		expect((await registry.get("web:c2"))?.title).toBe("Groups");
		expect(
			(await registry.setTitle("web:c2", undefined))?.title,
		).toBeUndefined();
		expect(await registry.setTitle("web:none", "x")).toBeUndefined();
	});

	test("a key without a surface prefix is refused", async () => {
		await expect(
			registry.register({
				key: "nosurface" as never,
				kind: "study",
				visibility: "shared",
			}),
		).rejects.toThrow("is not a channel key");
	});
});
