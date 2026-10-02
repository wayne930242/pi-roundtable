import { describe, expect, test } from "bun:test";
import { cloudflareAccess } from "./cloudflare-access.ts";
import { AUDIENCE, accessKeys, OWNER_EMAIL, TEAM } from "./testing/fixtures.ts";

const { keys, sign, strangerKey } = await accessKeys();
const verify = cloudflareAccess({
	teamDomain: TEAM,
	audience: AUDIENCE,
	email: OWNER_EMAIL,
	keys,
});

const request = (jwt?: string) =>
	new Request("http://console/console/api/config", {
		headers: jwt ? { "cf-access-jwt-assertion": jwt } : {},
	});

describe("cloudflareAccess", () => {
	test("admits a token signed by the team for the owner, whatever the email's case", async () => {
		expect(await verify(request(await sign()))).toEqual({ admitted: true });
		expect(
			await verify(request(await sign({ email: "Owner@Example.Test" }))),
		).toEqual({ admitted: true });
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
		).toEqual({ admitted: true });
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
