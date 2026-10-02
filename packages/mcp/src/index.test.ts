import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	describeDb,
	openTestStore,
	type TestStore,
} from "pi-roundtable/testing";
import { type ChannelGrant, ChannelGrantStore } from "./index.ts";

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("the exported ChannelGrantStore", () => {
	let store: TestStore<ChannelGrantStore>;

	beforeAll(async () => {
		store = await openTestStore(ChannelGrantStore);
	});

	afterAll(async () => {
		await store.close();
	});

	test("imports a bundle and a grant, as a host-side script would", async () => {
		const { bundle, created } = await store.ensureBundle(
			"imported",
			"imported-hash",
			["read"],
		);
		expect(created).toBe(true);
		const grant: ChannelGrant = {
			bundleId: bundle.id,
			channelId: "700",
			guildId: "900",
			operations: ["read", "send"],
			displayName: "Imported",
			description: "Brought over from another database",
			guildName: "Example Server",
			channelName: "imported",
			authorizedBy: "100000000000000001",
			authorizedAt: new Date("2026-01-02T03:04:05Z"),
		};
		await store.save(grant);
		expect(await store.bundleByTokenHash("imported-hash")).toEqual(bundle);
		expect(await store.grant(bundle.id, "700")).toEqual(grant);
	});
});
