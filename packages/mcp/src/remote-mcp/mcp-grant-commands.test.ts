import { expect, test } from "bun:test";
import type { ButtonInteraction } from "discord.js";
import { commandGuard } from "pi-roundtable/discord";
import { silentLogger } from "pi-roundtable/testing";
import { fakeInteraction } from "../testing/fake-interaction.ts";
import type { ChannelGrantStore } from "./channel-grants.ts";
import { mcpGrantCommands } from "./mcp-grant-commands.ts";
import type { McpGrantFlow } from "./mcp-grant-flow.ts";
import { MCP_IDS } from "./mcp-grant-panels.ts";
import { REMOTE_MCP_MESSAGES } from "./messages.ts";

const OWNER = "100000000000000001";
const SECOND_OWNER = "100000000000000006";

test("an owner revoked while their grant flow is open cannot complete it", async () => {
	let revoked = false;
	const owners = () => (revoked ? [OWNER] : [OWNER, SECOND_OWNER]);
	/** Two owners, each their own principal with one Discord identity, until the second is revoked. */
	const identity = {
		resolve: async (facts: { subject: string; name: string }) =>
			owners().includes(facts.subject)
				? {
						id: facts.subject,
						name: facts.name,
						tier: "owner" as const,
						principalId: facts.subject,
					}
				: undefined,
		owners: async () =>
			owners().map((id) => ({ id, displayName: id, disabled: false })),
		identities: async (principalId: string) => [
			{
				provider: "discord",
				subject: principalId,
				principalId,
				source: "config" as const,
				linkedAt: new Date(0),
			},
		],
	};
	const rotated: string[] = [];
	// SAFETY: the token flow reads only `bundleByName` and writes only `rotateToken`.
	const grants = {
		bundleByName: async (name: string) => ({ id: "b1", name }),
		rotateToken: async (bundleId: string) => {
			rotated.push(bundleId);
		},
	} as unknown as ChannelGrantStore;
	const { module } = mcpGrantCommands(
		commandGuard({
			ownerId: OWNER,
			identity,
			root: "roundtable",
			logger: silentLogger(),
		}),
		grants,
		"https://example.test",
		REMOTE_MCP_MESSAGES,
	);
	/** The second owner starts a token rotation and presses its button, revoked in between when asked. */
	const rotateAsSecondOwner = async (revokeBeforePress: boolean) => {
		const begun = fakeInteraction({
			user: SECOND_OWNER,
			group: "mcp",
			sub: "token",
			strings: { bundle: "ops" },
			guild: true,
		});
		expect(await module.handle(begun.interaction)).toBe(true);
		const rotate = begun.replies
			.customIds()
			.find((id) => id.startsWith(MCP_IDS.rotate));
		expect(rotate).toBeDefined();
		revoked = revokeBeforePress;
		const pressed = fakeInteraction({
			user: SECOND_OWNER,
			group: "mcp",
			sub: "token",
			button: rotate,
			guild: true,
		});
		expect(await module.handle(pressed.interaction)).toBe(true);
		return pressed.replies.text();
	};
	expect(await rotateAsSecondOwner(false)).toContain(
		REMOTE_MCP_MESSAGES.rotatedTitle,
	);
	expect(rotated).toEqual(["b1"]);
	// Told it expired, as anyone but its starter is.
	expect(await rotateAsSecondOwner(true)).toContain(
		REMOTE_MCP_MESSAGES.expiredTitle,
	);
	expect(rotated).toEqual(["b1"]);
});

test("a grant flow's press is told whether its presser is an owner; nothing assumes it", () => {
	const press = (flow: McpGrantFlow, interaction: ButtonInteraction) =>
		// @ts-expect-error The caller checks the presser at each press and says so; there is no default.
		flow.component(interaction);
	expect(press).toBeFunction();
});
