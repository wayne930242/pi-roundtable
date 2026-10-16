import { expect, test } from "bun:test";
import { entraV2Check, oidcJwtVerifier } from "./index.ts";
import { testIssuer } from "./testing/index.ts";

const TENANT = "11111111-1111-1111-1111-111111111111";
const SCOPE = "access_as_user";

const member = {
	tid: TENANT,
	ver: "2.0",
	acct: 0,
	scp: `openid ${SCOPE}`,
};

test("entraV2Check admits a member of the tenant with the scope", () => {
	const check = entraV2Check({ tenant: TENANT, scope: SCOPE });
	expect(check(member)).toBe(true);
	expect(check({ ...member, acct: "0" })).toBe(true);
});

test("entraV2Check refuses another tenant, v1 tokens, a missing or other scope", () => {
	const check = entraV2Check({ tenant: TENANT, scope: SCOPE });
	expect(check({ ...member, tid: "other" })).toBe(false);
	expect(check({ ...member, ver: "1.0" })).toBe(false);
	expect(check({ ...member, ver: undefined })).toBe(false);
	expect(check({ ...member, scp: undefined })).toBe(false);
	expect(check({ ...member, scp: "openid" })).toBe(false);
	expect(check({ ...member, scp: `${SCOPE}_more` })).toBe(false);
	expect(check({ ...member, scp: ["access_as_user"] })).toBe(false);
});

test("entraV2Check refuses guests and a missing or odd acct unless guests are admitted", () => {
	const members = entraV2Check({ tenant: TENANT, scope: SCOPE });
	expect(members({ ...member, acct: 1 })).toBe(false);
	expect(members({ ...member, acct: "1" })).toBe(false);
	expect(members({ ...member, acct: undefined })).toBe(false);
	expect(members({ ...member, acct: "" })).toBe(false);
	expect(members({ ...member, acct: false })).toBe(false);
	expect(members({ ...member, acct: 2 })).toBe(false);
	const guests = entraV2Check({ tenant: TENANT, scope: SCOPE, guests: true });
	expect(guests({ ...member, acct: 1 })).toBe(true);
	expect(guests({ ...member, acct: "1" })).toBe(true);
	expect(guests({ ...member, acct: 0 })).toBe(true);
	expect(guests({ ...member, acct: undefined })).toBe(false);
	expect(guests({ ...member, acct: 2 })).toBe(false);
	expect(guests({ ...member, tid: "other", acct: 1 })).toBe(false);
});

test("entraV2Check works as the check of a verifier over the test issuer", async () => {
	const idp = await testIssuer();
	try {
		const verify = oidcJwtVerifier({
			jwksUrl: idp.jwksUrl,
			issuers: [idp.issuer],
			audiences: [idp.audience],
			check: entraV2Check({ tenant: TENANT, scope: SCOPE }),
		});
		const good = await idp.sign({ claims: member });
		expect((await verify(good)).id).toContain("oidc:");
		const guest = await idp.sign({ claims: { ...member, acct: 1 } });
		await expect(verify(guest)).rejects.toThrow();
	} finally {
		await idp.close();
	}
});
