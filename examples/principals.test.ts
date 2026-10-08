import { expect, test } from "bun:test";
import { IDENTITY, type Speaker } from "pi-roundtable";
import { servicePair, testPlugin } from "pi-roundtable/testing";
import { access, principals } from "./principals.ts";

test("two actor identities of one principal ask about the same person", async () => {
	const lookedUp: string[] = [];
	const harness = await testPlugin(principals, {
		services: [
			servicePair(IDENTITY, {
				principal: async (id) => {
					lookedUp.push(id);
					return { id, displayName: "Mo", disabled: false };
				},
			}),
		],
	});
	try {
		for (const id of ["discord-actor", "web-actor"]) {
			const speaker: Speaker = {
				id,
				name: "Mo",
				principalId: "p_mo",
				tier: "member",
			};
			expect(await harness.runTool("principal_who", {}, { speaker })).toBe(
				"Mo (p_mo)",
			);
		}
		expect(lookedUp).toEqual(["p_mo", "p_mo"]);
	} finally {
		await harness.stop();
	}
});

test("an unavailable principal is refused even at owner tier", async () => {
	const harness = await testPlugin(principals, {
		services: [servicePair(IDENTITY, { principal: async () => undefined })],
	});
	try {
		expect(
			await harness.runTool("principal_who", {}, {
				speaker: {
					id: "actor",
					name: "Ada",
					principalId: "operator",
					tier: "owner",
				},
			}),
		).toContain("This principal is not available.");
		expect(access.owners[0]?.principal).toBe("operator");
		expect(access.members.roles).toEqual(["web:role:App.User"]);
	} finally {
		await harness.stop();
	}
});
