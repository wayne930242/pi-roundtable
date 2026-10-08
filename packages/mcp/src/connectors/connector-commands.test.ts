import { expect, test } from "bun:test";
import { commandGuard } from "pi-roundtable/discord";
import { silentLogger } from "pi-roundtable/testing";
import { fakeInteraction } from "../testing/fake-interaction.ts";
import { CONNECTOR_MODAL_ID, connectorCommands } from "./connector-commands.ts";
import type { ConnectorRegistry } from "./connector-registry.ts";
import { CONNECTOR_MESSAGES } from "./messages.ts";

const OWNER = "100000000000000001";
const SECOND_OWNER = "100000000000000006";
const MEMBER = "100000000000000003";

/** Two owners and a member, each their own principal with one Discord identity, as the identity service tells them. */
const identity = {
	resolve: async (facts: { subject: string; name: string }) => {
		const tier =
			facts.subject === OWNER || facts.subject === SECOND_OWNER
				? ("owner" as const)
				: facts.subject === MEMBER
					? ("member" as const)
					: undefined;
		return (
			tier && {
				id: facts.subject,
				name: facts.name,
				tier,
				principalId: facts.subject,
			}
		);
	},
	owners: async () =>
		[OWNER, SECOND_OWNER].map((id) => ({
			id,
			displayName: id,
			disabled: false,
		})),
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

test("a second owner's connector form reaches the registry; a member's is ignored", async () => {
	const added: string[] = [];
	// SAFETY: the form's submit calls only `add`; a refusal from it is shown as a panel.
	const registry = {
		add: async (connector: { name: string }) => {
			added.push(connector.name);
			throw new Error("not this test's concern");
		},
	} as unknown as ConnectorRegistry;
	const { module } = connectorCommands(
		commandGuard({
			ownerId: OWNER,
			identity,
			root: "roundtable",
			logger: silentLogger(),
		}),
		registry,
		CONNECTOR_MESSAGES,
	);
	const form = (user: string) =>
		fakeInteraction({
			user,
			group: "connector",
			sub: "add",
			modal: CONNECTOR_MODAL_ID,
			fields: { name: `from-${user}` },
		});
	const member = form(MEMBER);
	expect(await module.handle(member.interaction)).toBe(true);
	expect(member.replies.edits).toEqual([]);
	expect(await module.handle(form(SECOND_OWNER).interaction)).toBe(true);
	expect(added).toEqual([`from-${SECOND_OWNER}`]);
});
