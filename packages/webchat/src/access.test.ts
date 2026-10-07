import { expect, test } from "bun:test";
import { webAccess } from "./access.ts";

const person = (id: string, roles: string[] = []) => ({
	id,
	name: id,
	roles,
	expiresAt: new Date(Date.now() + 60_000),
});

test("maps roles and ids to the highest tier they qualify for, and admits no one else", () => {
	const access = webAccess({
		owners: ["oidc:op:boss"],
		admins: { roles: ["Chat.Admin"] },
		members: { roles: ["Chat.User"], users: ["oidc:op:guest"] },
	});
	expect(access.tierOf(person("oidc:op:boss"))).toBe("owner");
	expect(access.tierOf(person("oidc:op:x", ["Chat.User", "Chat.Admin"]))).toBe(
		"admin",
	);
	expect(access.tierOf(person("oidc:op:y", ["Chat.User"]))).toBe("member");
	expect(access.tierOf(person("oidc:op:guest"))).toBe("member");
	expect(access.tierOf(person("oidc:op:z", ["Other"]))).toBeUndefined();
});

test("owner comes only from a configured id, never from a token's roles", () => {
	const access = webAccess({
		members: { everyone: true },
	});
	expect(access.tierOf(person("oidc:op:x", ["owner", "Owner"]))).toBe("member");
	// There is no way to name owners by role.
	expect(() =>
		webAccess({ owners: { roles: ["Chat.Owner"] } } as never),
	).toThrow("owners");
});

test("refuses an access map that admits no one", () => {
	expect(() => webAccess({})).toThrow("admits no one");
});

test("refuses a map whose users or roles are not lists of strings, as a JavaScript config could write", () => {
	for (const map of [
		{ admins: { roles: "Chat.Admin" } },
		{ admins: { users: "oidc:op:ada" }, members: { everyone: true } },
		{ members: { roles: ["Chat.User", 7] } },
		{ owners: ["oidc:op:boss", null] },
		{ members: { everyone: "yes" } },
		{ admins: "Chat.Admin", members: { everyone: true } },
	])
		expect(() => webAccess(map as never)).toThrow("webAccess:");
});
