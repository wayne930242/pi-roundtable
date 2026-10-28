import { describe, expect, test } from "bun:test";
import { decodeJwt } from "jose";
import {
	cloudflareAccess,
	cloudflareAccessIdentity,
} from "./cloudflare-access.ts";
import {
	ACCESS_PROVIDER,
	AUDIENCE,
	accessKeys,
	OWNER_EMAIL,
	OWNER_SUB,
	TEAM,
} from "./testing/fixtures.ts";

const { keys, sign, strangerKey } = await accessKeys();
const verify = cloudflareAccess({
	teamDomain: TEAM,
	audience: AUDIENCE,
	email: OWNER_EMAIL,
	keys,
});

const expiryOf = (token: string) =>
	new Date((decodeJwt(token).exp ?? 0) * 1000);

const request = (jwt?: string) =>
	new Request("http://console/console/api/config", {
		headers: jwt ? { "cf-access-jwt-assertion": jwt } : {},
	});

describe("cloudflareAccess", () => {
	test("admits a token signed by the team for the owner, whatever the email's case, and reports who signed in", async () => {
		const owner = {
			admitted: true as const,
			actor: {
				provider: ACCESS_PROVIDER,
				subject: OWNER_SUB,
				name: OWNER_EMAIL,
			},
		};
		const token = await sign();
		expect(await verify(request(token))).toEqual({
			...owner,
			expiresAt: expiryOf(token),
		});
		const mixed = await sign({ email: "Owner@Example.Test" });
		expect(await verify(request(mixed))).toEqual({
			...owner,
			actor: { ...owner.actor, name: "owner@example.test" },
			expiresAt: expiryOf(mixed),
		});
	});

	test("reports when the admission lapses: the token's exp", async () => {
		const token = await sign();
		const verdict = await verify(request(token));
		const exp = decodeJwt(token).exp;
		expect(exp).toBeNumber();
		expect(verdict).toMatchObject({
			admitted: true,
			expiresAt: new Date((exp ?? 0) * 1000),
		});
		expect(
			(verdict as { expiresAt: Date }).expiresAt.getTime() - Date.now(),
		).toBeGreaterThan(50 * 60 * 1000);
	});

	test("reports the Access user id as the subject, under the team's issuer, as an OpenID identity", async () => {
		const verdict = await verify(request(await sign({ sub: "user-42" })));
		expect(verdict).toMatchObject({
			admitted: true,
			actor: {
				provider: `oidc:${Buffer.from(`https://${TEAM}`).toString("base64url")}`,
				subject: "user-42",
			},
		});
	});

	test("cloudflareAccessIdentity writes the identity a user is reported as", async () => {
		const verdict = await verify(request(await sign()));
		const actor = verdict.admitted ? verdict.actor : undefined;
		expect(cloudflareAccessIdentity(TEAM, OWNER_SUB)).toBe(
			`${actor?.provider}:${actor?.subject}`,
		);
	});

	test("refuses a token that names no user", async () => {
		const verdict = await verify(request(await sign({ sub: null })));
		expect(verdict).toEqual({
			admitted: false,
			reason: "Access token names no user",
		});
	});

	test("refuses a missing, forged, mis-addressed, or foreign token", async () => {
		const refused = async (jwt?: string) => {
			const verdict = await verify(request(jwt));
			return verdict.admitted ? "admitted" : verdict.reason;
		};
		expect(await refused()).toBe("no Access token");
		expect(await refused("not.a.jwt")).toBe("invalid Access token");
		expect(await refused(await sign({}, strangerKey))).toBe(
			"invalid Access token",
		);
		expect(await refused(await sign({ aud: "other" }))).toBe(
			"invalid Access token",
		);
		expect(await refused(await sign({ iss: "https://evil.example" }))).toBe(
			"invalid Access token",
		);
		expect(await refused(await sign({ email: "someone@example.test" }))).toBe(
			"email not allowed",
		);
	});

	test("admits any of several emails", async () => {
		const several = cloudflareAccess({
			teamDomain: TEAM,
			audience: AUDIENCE,
			email: [OWNER_EMAIL, "second@example.test"],
			keys,
		});
		expect(
			await several(request(await sign({ email: "second@example.test" }))),
		).toMatchObject({ admitted: true, actor: { name: "second@example.test" } });
	});

	test("refuses bad options when it is created", () => {
		const base = { teamDomain: TEAM, audience: AUDIENCE, email: OWNER_EMAIL };
		expect(() => cloudflareAccess({ ...base, teamDomain: "" })).toThrow(
			"teamDomain",
		);
		expect(() =>
			cloudflareAccess({ ...base, teamDomain: "https://team.example.test" }),
		).toThrow("teamDomain");
		expect(() => cloudflareAccess({ ...base, audience: " " })).toThrow(
			"audience",
		);
		expect(() => cloudflareAccess({ ...base, email: [] })).toThrow("email");
		expect(() => cloudflareAccess({ ...base, email: "" })).toThrow("email");
	});
});
