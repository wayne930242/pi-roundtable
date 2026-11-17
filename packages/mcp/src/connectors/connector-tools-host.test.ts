import { afterAll, afterEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { migrateDatabase } from "pi-roundtable";
import {
	describeDb,
	type TestHost,
	testDatabaseUrl,
	testHost,
} from "pi-roundtable/testing";
import { fakeContextForge } from "../testing/fake-contextforge.ts";
import { CONNECTORS, mcpConnectors } from "./connectors-plugin.ts";

/** The test host's owner, as `testHost` admits her. */
const ADA = {
	speaker: {
		id: "100000000000000001",
		name: "Ada",
		tier: "owner" as const,
		principalId: "100000000000000001",
	},
};

const UPSTREAM = "https://mcp.example.test/mcp/tok-5be1d0a7";

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("the connector tools on a host", () => {
	const cf = fakeContextForge();
	let running: TestHost | undefined;

	afterEach(async () => {
		await running?.stop();
		running = undefined;
	});
	afterAll(() => cf.stop());

	async function boot() {
		const plugin = mcpConnectors({
			contextForge: {
				url: cf.url,
				jwtSecret: "secret",
				user: "admin@example.com",
			},
			resyncIntervalMs: 0,
		});
		await migrateDatabase(testDatabaseUrl, [plugin]);
		const sql = new SQL(testDatabaseUrl);
		await sql`DELETE FROM owner_connectors`;
		await sql.close();
		cf.reset();
		cf.upstream[UPSTREAM] = ["search", "get-page"];
		running = await testHost({ plugins: [plugin] });
		await running.context.services.get(CONNECTORS).add({
			name: "notion",
			url: UPSTREAM,
			description: "Pages in the owner's Notion",
		});
		return running;
	}

	test("list, the remove card and remove itself name the host, never the URL", async () => {
		const host = await boot();
		const listed = await host.runTool("connector_list", {}, ADA);
		expect(listed).toContain("notion (https://mcp.example.test/…)");
		expect(listed).toContain("2 tools");
		expect(listed).not.toContain("tok-5be1d0a7");
		const card = await host.hold("connector_remove", { name: "notion" }, ADA);
		expect(JSON.stringify(card)).toContain(
			"remove connector notion (https://mcp.example.test/…)",
		);
		expect(JSON.stringify(card)).not.toContain("tok-5be1d0a7");
		const removed = await host.runTool(
			"connector_remove",
			{ name: "notion" },
			ADA,
		);
		expect(removed).toContain("Removed connector notion");
		expect(host.context.services.get(CONNECTORS).list()).toEqual([]);
		// The gateway and the virtual server went with it, as the connectors page removes them.
		expect(cf.requests.some((r) => r.startsWith("DELETE /gateways/"))).toBe(
			true,
		);
		expect(cf.requests.some((r) => r.startsWith("DELETE /servers/"))).toBe(
			true,
		);
	});

	test("an unknown name is refused with the names there are", async () => {
		const host = await boot();
		expect(
			await host.runTool("connector_remove", { name: "nope" }, ADA),
		).toContain("The connectors are: notion.");
	});

	test("without the web console, add sends the owner to the Discord command", async () => {
		const host = await boot();
		const out = await host.runTool("connector_add", { name: "drive" }, ADA);
		expect(out).toContain("/roundtable connector add");
	});

	test("a member's turn may not add or remove", async () => {
		const host = await boot();
		const member = {
			id: "200000000000000002",
			name: "Bo",
			tier: "member" as const,
			principalId: "200000000000000002",
		};
		for (const [name, args] of [
			["connector_remove", { name: "notion" }],
			["connector_add", { name: "drive" }],
		] as const)
			expect(await host.runTool(name, args, { speaker: member })).toContain(
				"owner",
			);
		expect(host.context.services.get(CONNECTORS).list()).toHaveLength(1);
	});
});
