import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { describeDb } from "pi-roundtable/testing";
import { bootE, type EHost, rest } from "../testing/e-host.ts";

// Runs against a real PostgreSQL, as the other hosted tests do.
describeDb("appearance.home reaches the page's config", () => {
	let boot: EHost;
	beforeAll(async () => {
		boot = await bootE({
			local: true,
			console: { appearance: { home: "chats" } },
		});
	}, 30_000);
	afterAll(async () => {
		await boot?.stop();
		if (boot) rmSync(boot.dataDir, { recursive: true, force: true });
	});

	test("the app section says chats, so the page opens on the chat list", async () => {
		const config = (await (await rest(boot, "config")).json()) as {
			app?: { home?: string };
		};
		expect(config.app?.home).toBe("chats");
	});
});
