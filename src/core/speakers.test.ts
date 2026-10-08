import { describe, expect, test } from "bun:test";
import { speakerPolicy, tierAtLeast } from "./speakers.ts";

const OWNER = "100000000000000001";
const ADMIN = "100000000000000002";
const MEMBER = "100000000000000003";
const ROLE = "200000000000000001";
const STRANGER = "100000000000000009";
const author = (id: string, roleIds: string[] = []) => ({
	id,
	name: `u${id.slice(-1)}`,
	roleIds,
});

describe("speakerPolicy", () => {
	test("names only the owner by default, so nobody else is a speaker", () => {
		const policy = speakerPolicy({ owners: [OWNER] });
		expect(policy.resolve(author(OWNER))?.tier).toBe("owner");
		expect(policy.resolve(author(STRANGER, [ROLE]))).toBeUndefined();
	});

	test("admins and members come from users or roles, and the highest tier wins", () => {
		const policy = speakerPolicy({
			owners: [OWNER],
			admins: { users: [ADMIN], roles: [ROLE] },
			members: { users: [MEMBER, ADMIN] },
		});
		expect(policy.resolve(author(ADMIN))?.tier).toBe("admin");
		expect(policy.resolve(author(STRANGER, [ROLE]))?.tier).toBe("admin");
		expect(policy.resolve(author(MEMBER))?.tier).toBe("member");
		expect(policy.resolve(author(OWNER, [ROLE]))?.tier).toBe("owner");
		expect(policy.resolve(author(STRANGER))).toBeUndefined();
	});

	test("@everyone makes every author a member", () => {
		const policy = speakerPolicy({
			owners: [OWNER],
			members: { everyone: true },
		});
		expect(policy.resolve(author(STRANGER))).toEqual({
			id: STRANGER,
			name: "u9",
			tier: "member",
			principalId: STRANGER,
		});
	});
});

test("tiers order owner above admin above member", () => {
	expect(tierAtLeast("owner", "admin")).toBe(true);
	expect(tierAtLeast("admin", "admin")).toBe(true);
	expect(tierAtLeast("member", "admin")).toBe(false);
});
