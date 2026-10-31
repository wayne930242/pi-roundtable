// In-memory connector and MCP authorization ports for the fixture hosts, so the Connectors page's
// management can be tried with no ContextForge and no Discord. A connector named `taken`, a URL
// that is not http(s), or a header without a token is refused the way pi-roundtable-mcp refuses it.
import type { ConsoleFeatures, ManagedConnector } from "../src/features.ts";

class Refusal extends Error {
	readonly refusal = true;
}

const OPERATIONS = [
	{ id: "read", label: "Read messages" },
	{ id: "send", label: "Send messages" },
	{ id: "react", label: "Add reactions" },
	{ id: "pin", label: "Pin messages" },
];

const CHANNELS = [
	{ id: "300000000000000001", name: "lobby", guild: "Fixture server" },
	{ id: "300000000000000002", name: "ops", guild: "Fixture server" },
	{ id: "300000000000000003", name: "announcements", guild: "Fixture server" },
];

interface Grant {
	channelId: string;
	displayName: string;
	description: string;
	operations: string[];
	authorizedAt: Date;
	audit: { tool: string; status: string; createdAt: Date }[];
}

const url = () =>
	`https://fixture.example.test/mcp/discord/${crypto.randomUUID().replaceAll("-", "")}`;

export function fixtureConnectorFeatures(): Pick<
	ConsoleFeatures,
	"connectors" | "mcpGrants"
> {
	const connectors: ManagedConnector[] = [
		{
			name: "notion",
			url: "https://mcp.notion.example.test/v1/sk-fixture-secret/mcp",
			description: "Pages and databases in the owner's Notion workspace",
			server: { tools: ["notion-search", "notion-get-page", "notion-update"] },
		},
		{
			name: "weather",
			url: "https://weather.example.test/",
			description: "Forecasts by city",
		},
	];
	const now = new Date();
	const bundles = new Map<string, Grant[]>([
		[
			"ops-bot",
			[
				{
					channelId: CHANNELS[0]?.id ?? "",
					displayName: "Lobby",
					description: "Where the team chats",
					operations: ["read", "send"],
					authorizedAt: now,
					audit: [
						{
							tool: "discord_send_message",
							status: "succeeded",
							createdAt: now,
						},
						{ tool: "authorize", status: "succeeded", createdAt: now },
					],
				},
			],
		],
	]);
	const grantOf = (bundle: string, channelId: string) => {
		const grant = bundles.get(bundle)?.find((g) => g.channelId === channelId);
		if (!grant) throw new Refusal(`This channel is not in bundle ${bundle}.`);
		return grant;
	};
	return {
		connectors: {
			gateways: async () =>
				connectors.map((c) => ({
					name: c.name,
					enabled: true,
					reachable: c.server !== undefined,
					tools: c.server?.tools.length ?? 0,
				})),
			servers: async () =>
				connectors.flatMap((c) =>
					c.server
						? [
								{
									name: `roundtable-conn-${c.name}`,
									tools: [...c.server.tools],
								},
							]
						: [],
				),
			usedBy: () => ["Scout"],
			manage: {
				list: () => connectors,
				add: async (input) => {
					const name = input.name.trim().toLowerCase();
					if (!/^[a-z][a-z0-9-]{0,11}$/.test(name))
						throw new Refusal(
							"Use lowercase letters, digits and `-`, start with a letter, and keep it to 12 characters.",
						);
					if (!/^https?:\/\//.test(input.url))
						throw new Refusal(
							"The URL must start with `https://` or `http://`.",
						);
					if (input.header && !input.token)
						throw new Refusal("A header name needs a token with it.");
					if (name === "taken" || connectors.some((c) => c.name === name))
						throw new Refusal(
							`The name \`${name}\` is already taken. Pick another.`,
						);
					const connector = {
						name,
						url: input.url,
						description: input.description.trim(),
						server: { tools: [`${name}-search`, `${name}-read`] },
					};
					connectors.push(connector);
					return { connector, skipped: [] };
				},
				describe: async (name, description) => {
					const connector = connectors.find((c) => c.name === name);
					if (!connector)
						throw new Refusal(`There is no connector named \`${name}\`.`);
					if (!description.trim())
						throw new Refusal("The purpose cannot be empty.");
					connector.description = description.trim();
					return connector;
				},
				remove: async (name) => {
					const at = connectors.findIndex((c) => c.name === name);
					if (at < 0)
						throw new Refusal(`There is no connector named \`${name}\`.`);
					connectors.splice(at, 1);
				},
			},
		},
		mcpGrants: {
			operations: OPERATIONS,
			bundles: async () =>
				[...bundles].map(([name, grants]) => ({
					name,
					grants: grants.map((g) => {
						const channel = CHANNELS.find((c) => c.id === g.channelId);
						return {
							...g,
							guildName: channel?.guild ?? "Fixture server",
							channelName: channel?.name ?? "gone",
							visible: channel !== undefined,
						};
					}),
				})),
			channels: async () => CHANNELS,
			revoke: async (bundle, channelId) => {
				grantOf(bundle, channelId);
				bundles.set(
					bundle,
					(bundles.get(bundle) ?? []).filter((g) => g.channelId !== channelId),
				);
			},
			describe: async (bundle, channelId, change) => {
				const grant = grantOf(bundle, channelId);
				if (change.displayName !== undefined)
					grant.displayName = change.displayName;
				if (change.description !== undefined)
					grant.description = change.description;
			},
			rotate: async (bundle) => {
				if (!bundles.has(bundle))
					throw new Refusal(`There is no bundle "${bundle}".`);
				return { url: url() };
			},
			authorize: async (input) => {
				const bundle = input.bundle.trim();
				if (!bundle || bundle.length > 80)
					throw new Refusal("A bundle name needs 1 to 80 characters.");
				if (input.operations.length === 0)
					throw new Refusal("Choose one or more of the allowed operations.");
				const channel = CHANNELS.find((c) => c.id === input.channelId);
				if (!channel)
					throw new Refusal(
						"Only text or announcement channels in a server can be authorized.",
					);
				const created = !bundles.has(bundle);
				const grants = (bundles.get(bundle) ?? []).filter(
					(g) => g.channelId !== channel.id,
				);
				const at = new Date();
				grants.push({
					channelId: channel.id,
					displayName: input.displayName ?? channel.name,
					description: input.description ?? "",
					operations: [...input.operations],
					authorizedAt: at,
					audit: [{ tool: "authorize", status: "succeeded", createdAt: at }],
				});
				bundles.set(bundle, grants);
				return created ? { bundle, url: url() } : { bundle };
			},
		},
	};
}
