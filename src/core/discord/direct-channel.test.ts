import { describe, expect, test } from "bun:test";
import type { ChannelKey } from "../domain/conversation.ts";
import type { IdentityLink } from "../identity/principal-store.ts";
import { discordDirectChannel } from "./direct-channel.ts";

const OWNER = "100000000000000001";

/** The links of each principal, as the identity service keeps them. */
function identities(links: Record<string, string[]>) {
	return {
		identities: async (principalId: string): Promise<IdentityLink[]> =>
			(links[principalId] ?? []).map((identity) => {
				const [provider = "", subject = ""] = identity.split(/:(.*)/);
				return {
					provider,
					subject,
					principalId,
					source: "config",
					linkedAt: new Date(0),
				} as IdentityLink;
			}),
	};
}

function provider(links?: Record<string, string[]>) {
	const sent: { user: string; text: string }[] = [];
	const channel = discordDirectChannel({
		directChannel: async (user): Promise<ChannelKey> => `discord:dm-${user}`,
		sendDirect: async (user, text) => void sent.push({ user, text }),
		...(links ? { identity: identities(links) } : {}),
		ownerId: OWNER,
	});
	return { channel, sent };
}

describe("the Discord direct channel", () => {
	test("reaches the single owner in the direct messages 0.8 used, by their configured Discord identity", async () => {
		const { channel, sent } = provider({
			[OWNER]: ["token:remote-mcp", `discord:${OWNER}`],
		});
		expect(channel.name).toBe("discord");
		expect(channel.label).toBe("a direct message on Discord");
		expect(await channel.reaches(OWNER)).toBe(`discord:dm-${OWNER}`);
		await channel.deliver?.(OWNER, "done");
		expect(sent).toEqual([{ user: OWNER, text: "done" }]);
	});

	test("reaches another principal through a Discord identity of theirs, the primary owner's first among several", async () => {
		const { channel } = provider({
			ada: ["discord:200", `discord:${OWNER}`],
			bo: ["oidc:aXNz:bo", "discord:300", "discord:301"],
		});
		expect(await channel.reaches("ada")).toBe(`discord:dm-${OWNER}`);
		expect(await channel.reaches("bo")).toBe("discord:dm-300");
	});

	test("does not reach a principal with no Discord identity, and refuses to deliver to one", async () => {
		const { channel, sent } = provider({ kai: ["oidc:aXNz:kai"] });
		expect(await channel.reaches("kai")).toBeUndefined();
		expect(await channel.reaches("nobody")).toBeUndefined();
		await expect(channel.deliver?.("kai", "hi")).rejects.toThrow(
			"no Discord identity",
		);
		expect(sent).toEqual([]);
	});

	test("without the identity service, reaches only the primary owner, whose principal is their Discord id", async () => {
		const { channel } = provider();
		expect(await channel.reaches(OWNER)).toBe(`discord:dm-${OWNER}`);
		expect(await channel.reaches("200")).toBeUndefined();
	});
});
