import { describe, expect, test } from "bun:test";
import { displayUrl } from "./connector-input.ts";
import {
	type Connector,
	ConnectorError,
	type NewConnector,
} from "./connector-registry.ts";
import { connectorManagement } from "./connectors-plugin.ts";
import { CONNECTOR_MESSAGES, connectorMessages } from "./messages.ts";

const connector = (name: string, description = "Pages"): Connector => ({
	name,
	url: "https://mcp.example.test/mcp",
	description,
	gatewayId: "g1",
	serverId: "s1",
	createdAt: new Date(0),
});

/** The registry's management calls, recorded. */
function fakeRegistry() {
	const added: NewConnector[] = [];
	const described: [string, string][] = [];
	const removed: string[] = [];
	return {
		added,
		described,
		removed,
		registry: {
			add: async (input: NewConnector) => {
				added.push(input);
				return { connector: connector(input.name), skipped: [] };
			},
			describe: async (name: string, description: string) => {
				described.push([name, description]);
				return connector(name, description);
			},
			remove: async (name: string) => {
				removed.push(name);
			},
		},
	};
}

const base = {
	name: " notion ",
	url: " https://mcp.example.test/mcp ",
	description: " Pages ",
};

describe("connector management", () => {
	test("add follows the form's rules: no token, a bearer token, or a named header", async () => {
		const { registry, added } = fakeRegistry();
		const manage = connectorManagement(registry, CONNECTOR_MESSAGES);
		await manage.add(base);
		await manage.add({ ...base, token: " t1 " });
		await manage.add({ ...base, header: "X-API-Key", token: "t2" });
		expect(added.map((a) => a.auth)).toEqual([
			{ type: "none" },
			{ type: "bearer", token: "t1" },
			{ type: "header", name: "X-API-Key", value: "t2" },
		]);
		expect(added[0]).toMatchObject({
			name: "notion",
			url: "https://mcp.example.test/mcp",
			description: "Pages",
		});
	});

	test("a header without a token, or an unusable header name, is a refusal in the configured wording", async () => {
		const { registry, added } = fakeRegistry();
		const text = connectorMessages({ headerNeedsToken: "Need a token." });
		const manage = connectorManagement(registry, text);
		const without = manage.add({ ...base, header: "X-Key" });
		await expect(without).rejects.toThrow("Need a token.");
		await expect(without).rejects.toBeInstanceOf(ConnectorError);
		const bad = manage.add({ ...base, header: "X Key", token: "t" });
		await expect(bad).rejects.toThrow(CONNECTOR_MESSAGES.headerRule);
		await bad.catch((error) => expect(error.refusal).toBe(true));
		expect(added).toEqual([]);
	});

	test("the returned connector never holds the token", async () => {
		const { registry } = fakeRegistry();
		const manage = connectorManagement(registry, CONNECTOR_MESSAGES);
		const result = await manage.add({ ...base, token: "very-secret-token" });
		expect(JSON.stringify(result)).not.toContain("very-secret-token");
	});

	test("describe and remove reach the registry", async () => {
		const { registry, described, removed } = fakeRegistry();
		const manage = connectorManagement(registry, CONNECTOR_MESSAGES);
		expect((await manage.describe("notion", "Docs")).description).toBe("Docs");
		await manage.remove("notion");
		expect(described).toEqual([["notion", "Docs"]]);
		expect(removed).toEqual(["notion"]);
	});
});

test.each([
	["https://mcp.example.test/", "https://mcp.example.test"],
	["https://mcp.example.test/mcp", "https://mcp.example.test/…"],
	["https://mcp.example.test/?key=secret", "https://mcp.example.test/…"],
	["https://user:pw@mcp.example.test/", "https://mcp.example.test/…"],
	["not a url", "(unreadable)"],
])("displayUrl shows %s as %s", (url, shown) => {
	expect(displayUrl(url, "(unreadable)")).toBe(shown);
});
