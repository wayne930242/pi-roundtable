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

	test("a shared conversation stays shared after a private turn on the same key: the first registration fixes it", async () => {
		await registry.register({
			key: "discord:study-room-1",
			kind: "study",
			visibility: "shared",
		});
		const again = await registry.register({
			key: "discord:study-room-1",
			kind: "study",
			visibility: "private",
			principalId: "eve",
		});
		expect(again.visibility).toBe("shared");
		expect(again.principalId).toBeUndefined();
		expect(await registry.list({ principal: "eve" })).toEqual([]);
	});

	test("adopt makes a conversation recorded shared with no principal, as before 0.9, private to the principal, once", async () => {
		const first = await registry.register({
			key: "mcp:0-8-session",
			kind: "remote",
			visibility: "shared",
		});
		const adopted = await registry.adopt("mcp:0-8-session", "ada");
		expect(adopted).toMatchObject({
			kind: "remote",
			visibility: "private",
			principalId: "ada",
		});
		expect(adopted?.createdAt).toEqual(first.createdAt);
		expect(adopted?.lastActiveAt).toEqual(first.lastActiveAt);
		// Then it is Ada's: adopting it again, or for another, changes nothing.
		expect(await registry.adopt("mcp:0-8-session", "ada")).toEqual(adopted);
		expect(await registry.adopt("mcp:0-8-session", "bo")).toEqual(adopted);
		expect(await registry.adopt("mcp:unknown", "ada")).toBeUndefined();
	});

	test("adopt never touches a private conversation or one that names a principal", async () => {
		const mine = await registry.register({
			key: "web:mine",
			kind: "study",
			visibility: "private",
			principalId: "ada",
		});
		const named = await registry.register({
			key: "fake:named",
			kind: "study",
			visibility: "shared",
			principalId: "ada",
		});
		expect(await registry.adopt("web:mine", "bo")).toEqual(mine);
		expect(await registry.adopt("fake:named", "bo")).toEqual(named);
	});

	test("adopts racing for one conversation give it to exactly one principal, and each sees that one", async () => {
		await registry.register({
			key: "mcp:raced",
			kind: "remote",
			visibility: "shared",
		});
		const results = await Promise.all(
			["ada", "bo", "kai", "eve"].map((principal) =>
				registry.adopt("mcp:raced", principal),
			),
		);
		const owners = new Set(results.map((record) => record?.principalId));
		expect(owners.size).toBe(1);
		const [winner] = owners;
		expect(await registry.get("mcp:raced")).toMatchObject({
			visibility: "private",
			principalId: winner,
		});
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
