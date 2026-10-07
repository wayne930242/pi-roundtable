import { describe, expect, test } from "bun:test";
import { ConfigError } from "../domain/errors.ts";
import {
	type AccessRules,
	checkAccessRules,
	factsTier,
} from "./access-policy.ts";
import { identityOf, parseIdentity } from "./actor-facts.ts";

describe("identity strings", () => {
	test("are <provider>:<subject>, an OIDC provider carrying its issuer, so an OIDC identity is the 0.8 web speaker id", () => {
		expect(parseIdentity("discord:966666600000000001")).toEqual({
			provider: "discord",
			subject: "966666600000000001",
		});
		expect(parseIdentity("token:remote-mcp")).toEqual({
			provider: "token",
			subject: "remote-mcp",
		});
		expect(
			parseIdentity("oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20:user:7"),
		).toEqual({
			provider: "oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20",
			subject: "user:7",
		});
		expect(
			identityOf({
				provider: "oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20",
				subject: "user-7",
			}),
		).toBe("oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20:user-7");
		for (const bad of ["discord", "discord:", ":1", "oidc:abc", "oidc::1"])
			expect(parseIdentity(bad)).toBeUndefined();
	});
});

const RULES: AccessRules = {
	owners: [],
	admins: {
		identities: ["discord:966666600000000011"],
		roles: ["discord:role:7"],
	},
	members: { roles: ["web:role:App.User"], everyone: ["discord"] },
	provisioning: "admitted",
	backgroundStaleDays: 30,
};

describe("factsTier", () => {
	test("gives the highest tier the facts qualify for, by identity, role, or everyone on a surface", () => {
		expect(
			factsTier(RULES, {
				provider: "discord",
				subject: "966666600000000011",
				name: "A",
			}),
		).toBe("admin");
		expect(
			factsTier(RULES, {
				provider: "discord",
				subject: "966666600000000012",
				name: "B",
				roles: ["discord:role:7"],
			}),
		).toBe("admin");
		// everyone: ["discord"] admits any Discord author as a member, and no one elsewhere.
		expect(
			factsTier(RULES, {
				provider: "discord",
				subject: "966666600000000013",
				name: "C",
			}),
		).toBe("member");
		expect(
			factsTier(RULES, {
				provider: "oidc:aWRw",
				subject: "u1",
				name: "D",
				surface: "web",
			}),
		).toBeUndefined();
		expect(
			factsTier(RULES, {
				provider: "oidc:aWRw",
				subject: "u1",
				name: "D",
				surface: "web",
				roles: ["web:role:App.User"],
			}),
		).toBe("member");
		// everyone: true admits on every surface.
		expect(
			factsTier(
				{ ...RULES, members: { everyone: true } },
				{ provider: "oidc:aWRw", subject: "u1", name: "D", surface: "web" },
			),
		).toBe("member");
	});

	test("never gives the owner tier, whatever role the facts claim", () => {
		expect(
			factsTier(RULES, {
				provider: "discord",
				subject: "966666600000000014",
				name: "E",
				roles: ["owner", "discord:role:owner"],
			}),
		).toBe("member");
	});

	test("the surface is the facts' own, else the conversation's, else the provider's first part", () => {
		const web = { ...RULES, members: { everyone: ["web"] } };
		const facts = { provider: "oidc:aWRw", subject: "u1", name: "D" };
		expect(factsTier(web, facts)).toBeUndefined();
		expect(factsTier(web, facts, "web:c-1")).toBe("member");
		expect(factsTier(web, { ...facts, surface: "web" })).toBe("member");
	});
});

describe("checkAccessRules", () => {
	const owner = { name: "Ada", identities: ["discord:966666600000000001"] };

	test("refuses an identity two owners list, a malformed identity, and the system principal", () => {
		expect(() =>
			checkAccessRules({ ...RULES, owners: [owner, { ...owner, name: "Bo" }] }),
		).toThrow(ConfigError);
		expect(() =>
			checkAccessRules({
				...RULES,
				owners: [{ name: "Ada", identities: ["discord"] }],
			}),
		).toThrow(/access\.owners\[0\]\.identities\[0\]/);
		expect(() =>
			checkAccessRules({
				...RULES,
				owners: [{ ...owner, principal: "system" }],
			}),
		).toThrow(ConfigError);
		expect(() =>
			checkAccessRules({
				...RULES,
				owners: [
					{ ...owner, principal: "966666600000000001" },
					{ name: "Bo", principal: "966666600000000001", identities: [] },
				],
			}),
		).toThrow(ConfigError);
		expect(() =>
			checkAccessRules({ ...RULES, admins: { identities: ["nope"] } }),
		).toThrow(/access\.admins\.identities\[0\]/);
		expect(() => checkAccessRules({ ...RULES, owners: [owner] })).not.toThrow();
	});
});
