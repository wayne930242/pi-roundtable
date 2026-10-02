import { expect, test } from "bun:test";
import { servicePair, testPlugin } from "pi-roundtable/testing";
import { CONNECTORS, type Connectors } from "pi-roundtable-mcp";
import { connectorRouting } from "./connector-profiles.ts";

test("the routing plugin builds a line per connector from the service", async () => {
	const seen: string[][] = [];
	const connectors: Connectors = {
		version: 3,
		token: "t",
		resolve: async () => {
			throw new Error("not used");
		},
		admin: {
			gateways: async () => [],
			servers: async () => [],
		},
		list: () => [],
		servers: () => [],
		profileSources: () => [
			{ name: "notion", description: "Pages", serverName: "x-notion" },
		],
	};
	const harness = await testPlugin(
		connectorRouting((lines) => seen.push(lines)),
		{ services: [servicePair(CONNECTORS, connectors)] },
	);
	await harness.stop();
	expect(seen).toEqual([["notion: Pages"]]);
});
