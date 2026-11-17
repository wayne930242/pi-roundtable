import { describe, expect, test } from "bun:test";
import { type HoldRule, ToolRefusal } from "pi-roundtable";
import { holdChain, YOLO_NEVER_CLASS } from "pi-roundtable/kit";
import type { Connector } from "./connector-results.ts";
import { ConnectorError } from "./connector-results.ts";
import {
	CONNECTOR_TOOL_PARAMETERS,
	type ConnectorAddRequest,
	type ConnectorToolsOptions,
	connectorActs,
	connectorHoldRule,
	connectorTools,
} from "./connector-tools.ts";
import { CONNECTOR_MESSAGES } from "./messages.ts";

const SECRET = "tok-9f3a7c51e2";
const URL_WITH_TOKEN = `https://notes.example/mcp/${SECRET}`;

const connector = (name: string, url: string, tools?: string[]): Connector =>
	({
		name,
		url,
		description: `${name} purpose`,
		gatewayId: "g",
		serverId: "s",
		createdAt: new Date(0),
		...(tools ? { server: { name: `conn-${name}`, tools } } : {}),
	}) as Connector;

const owner = {
	speaker: { id: "u1", name: "Wei", tier: "owner" as const, principalId: "p1" },
	channel: "app:agent:arthur" as const,
};
const member = {
	...owner,
	speaker: { ...owner.speaker, tier: "member" as const },
};

function setup(made?: { link: string } | "none") {
	const connectors = [
		connector("notes", URL_WITH_TOKEN, ["a", "b", "c"]),
		connector("cal", "https://cal.example/", undefined),
	];
	const removed: string[] = [];
	const asked: ConnectorAddRequest[] = [];
	const options: ConnectorToolsOptions = {
		connectors: () => connectors,
		remove: async (name) => {
			removed.push(name);
		},
		requests: () =>
			made === undefined
				? undefined
				: {
						minutes: 60,
						create: async (request) => {
							asked.push(request);
							return made === "none" ? undefined : made;
						},
					},
		command: () => "/rt connector add",
		text: CONNECTOR_MESSAGES,
	};
	return { acts: connectorActs(options), options, removed, asked };
}

describe("connector tools", () => {
	test("no schema takes a URL or token, and none accepts extra fields", () => {
		for (const schema of Object.values(CONNECTOR_TOOL_PARAMETERS)) {
			const keys = Object.keys(schema.properties);
			expect(keys.some((k) => /url|token|header|secret/i.test(k))).toBe(false);
			expect(
				(schema as { additionalProperties?: unknown }).additionalProperties,
			).toBe(false);
		}
		expect(
			Object.keys(CONNECTOR_TOOL_PARAMETERS.connector_add.properties),
		).toEqual(["name", "description"]);
	});

	test("add and remove are the owner's; list is anyone's", () => {
		const tiers = Object.fromEntries(
			connectorTools(setup().options).map((t) => [t.name, t.minTier]),
		);
		expect(tiers).toEqual({
			connector_list: "member",
			connector_add: "owner",
			connector_remove: "owner",
		});
	});

	test("list shows the host, the tool count and the purpose, never the URL", () => {
		const out = setup().acts.list();
		expect(out).not.toContain(SECRET);
		expect(out).toContain(
			"notes (https://notes.example/…), reachable, 3 tools",
		);
		expect(out).toContain("cal (https://cal.example), tools unreadable");
		expect(out).toContain("notes purpose");
	});

	test("remove removes through the registry, and names the others for an unknown name", async () => {
		const { acts, removed } = setup();
		expect(await acts.remove({ name: "notes" }, owner)).toContain("notes");
		expect(removed).toEqual(["notes"]);
		const unknown = acts.remove({ name: "nope" }, owner);
		await expect(unknown).rejects.toBeInstanceOf(ToolRefusal);
		await expect(acts.remove({ name: "nope" }, owner)).rejects.toThrow(
			"The connectors are: notes, cal.",
		);
	});

	test("a registry refusal on remove is the model's to read", async () => {
		const { options } = setup();
		const acts = connectorActs({
			...options,
			remove: async () => {
				throw new ConnectorError("the gateway answered 500: x");
			},
		});
		await expect(acts.remove({ name: "notes" }, owner)).rejects.toBeInstanceOf(
			ToolRefusal,
		);
	});

	test("a speaker below owner can neither add nor remove", async () => {
		const { acts, removed, asked } = setup({
			link: "https://x/#/connectors?add=1",
		});
		await expect(acts.remove({ name: "notes" }, member)).rejects.toThrow(
			CONNECTOR_MESSAGES.toolOwnerOnly,
		);
		await expect(acts.add({ name: "drive" }, member)).rejects.toThrow(
			CONNECTOR_MESSAGES.toolOwnerOnly,
		);
		await expect(
			acts.add({ name: "drive" }, { ...owner, speaker: undefined }),
		).rejects.toThrow(CONNECTOR_MESSAGES.toolOwnerOnly);
		expect(removed).toEqual([]);
		expect(asked).toEqual([]);
	});

	test("add makes a request of name, purpose and conversation only, and returns its link", async () => {
		const { acts, asked } = setup({
			link: "https://web.example/app/#/connectors?add=r1",
		});
		const out = await acts.add(
			{ name: "drive", description: " files " },
			owner,
		);
		expect(out).toContain("https://web.example/app/#/connectors?add=r1");
		expect(out).toContain("60 minutes");
		expect(asked).toEqual([
			{
				name: "drive",
				description: "files",
				conversation: "app:agent:arthur",
				requestedBy: "p1",
			},
		]);
	});

	test("add refuses any field but name and description, and a taken name", async () => {
		const { acts, asked } = setup({ link: "l" });
		await expect(
			acts.add({ name: "drive", url: URL_WITH_TOKEN } as never, owner),
		).rejects.toThrow("takes only name and description");
		await expect(acts.add({ name: "notes" }, owner)).rejects.toThrow(
			"already taken",
		);
		expect(asked).toEqual([]);
	});

	test("without the web console's form, add sends the owner to the Discord command and makes nothing", async () => {
		for (const made of [undefined, "none"] as const) {
			const { acts } = setup(made);
			const out = await acts.add({ name: "drive" }, owner);
			expect(out).toContain("/rt connector add");
			expect(out).not.toContain("http");
		}
	});
});

describe("the connector hold rule", () => {
	const rule = (): HoldRule => connectorHoldRule(setup().options);

	test("holds every remove, with the name and host only", () => {
		const text = rule().describe("connector_remove", { name: "notes" }, {});
		expect(text).toBe(
			"remove connector notes (https://notes.example/…), its token and its tools",
		);
		expect(text).not.toContain(SECRET);
		expect(rule().describe("connector_remove", { name: "gone" }, {})).toContain(
			"gone",
		);
		expect(rule().describe("connector_list", {}, {})).toBeUndefined();
		expect(rule().describe("connector_add", { name: "x" }, {})).toBeUndefined();
	});

	test("is a rule yolo never approves: its calls carry the yolo-never class", () => {
		expect(rule().yolo).toBe("never");
		const classes = holdChain([rule()]).classesOf?.(
			"connector_remove",
			{ name: "notes" },
			{},
		);
		expect(classes).toEqual([`connector.${YOLO_NEVER_CLASS}`]);
	});
});
