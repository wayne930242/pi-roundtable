import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	identityActor,
	oidcJwtVerifier,
	oidcSpeakerId,
	parseOidcSpeakerId,
	TokenRefused,
} from "./oidc.ts";
import { type TestIssuer, testIssuer } from "./testing/issuer.ts";

let idp: TestIssuer;
beforeEach(async () => {
	idp = await testIssuer();
});
afterEach(async () => {
	await idp.close();
});

const verifier = (extra: Partial<Parameters<typeof oidcJwtVerifier>[0]> = {}) =>
	oidcJwtVerifier({
		jwksUrl: idp.jwksUrl,
		issuers: [idp.issuer],
		audiences: [idp.audience],
		...extra,
	});

async function refusal(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(TokenRefused);
		return (error as TokenRefused).reason;
	}
	throw new Error("the token was accepted");
}

test("custom verifier actors may name only OIDC or this chat's surface", () => {
	const identity = {
		id: "custom",
		name: "Ada",
		roles: ["User"],
		expiresAt: new Date(),
	};
	for (const provider of ["oidc:issuer", "support"]) {
		expect(
			identityActor(
				{ ...identity, actor: { provider, subject: "ada", name: "Ada" } },
				"support",
			),
		).toMatchObject({
			provider,
			subject: "ada",
			surface: "support",
			roles: ["support:role:User"],
		});
	}
	for (const provider of ["token", "discord", "web", "oidc", "oidc-impostor"]) {
		const bad = () =>
			identityActor(
				{
					...identity,
					actor: { provider, subject: "remote-mcp", name: "Ada" },
				},
				"support",
			);
		expect(bad).toThrow(TokenRefused);
		expect(bad).toThrow(
			'provider must start with "oidc:" or equal this webchat surface "support"',
		);
	}
});

test("a speaker id is reversible and keeps issuers with colons apart", () => {
	const id = oidcSpeakerId("https://login.example.test/t/v2.0", "a:b");
	expect(id).toStartWith("oidc:");
	expect(id.split(":")).toHaveLength(4);
	expect(parseOidcSpeakerId(id)).toEqual({
		issuer: "https://login.example.test/t/v2.0",
		subject: "a:b",
	});
	expect(parseOidcSpeakerId("discord:123")).toBeUndefined();
	expect(parseOidcSpeakerId("oidc:not base64:x")).toBeUndefined();
});

test("a valid token names the person by issuer and subject, with their name, roles, and expiry", async () => {
	const identity = await verifier()(await idp.sign());
	expect(identity.id).toBe(oidcSpeakerId(idp.issuer, "subject-1"));
	expect(identity.name).toBe("Ada");
	expect(identity.roles).toEqual(["Chat.User"]);
	expect(identity.actor).toEqual({
		provider: `oidc:${Buffer.from(idp.issuer).toString("base64url")}`,
		subject: "subject-1",
		name: "Ada",
		surface: "web",
		roles: ["web:role:Chat.User"],
		legacyId: identity.id,
	});
	expect(identityActor(identity, "support")).toMatchObject({
		surface: "support",
		roles: ["support:role:Chat.User"],
		legacyId: identity.id,
	});
	expect(identity.expiresAt.getTime()).toBeGreaterThan(Date.now());
});

test("ES256 is accepted by default; the JWKS is fetched once and cached", async () => {
	const verify = verifier();
	await verify(await idp.sign({ alg: "ES256" }));
	await verify(await idp.sign());
	expect(idp.fetches).toBe(1);
});

test("refuses an expired token, one not valid yet, and one for another audience or issuer", async () => {
	const now = Math.floor(Date.now() / 1000);
	const verify = verifier({ clockSkewSeconds: 30 });
	expect(
		await refusal(verify(await idp.sign({ claims: { exp: now - 31 } }))),
	).toContain("exp");
	expect(
		await refusal(verify(await idp.sign({ claims: { nbf: now + 31 } }))),
	).toContain("nbf");
	expect(
		await refusal(verify(await idp.sign({ claims: { aud: "api://other" } }))),
	).toContain("aud");
	expect(
		await refusal(
			verify(await idp.sign({ claims: { iss: "https://evil.example.test" } })),
		),
	).toContain("iss");
	// Within the skew both still pass.
	await verify(await idp.sign({ claims: { exp: now - 5, nbf: now + 5 } }));
});

test("refuses a token without exp or sub, a key the JWKS does not publish, and garbage", async () => {
	const verify = verifier();
	expect(await refusal(verify(await idp.sign({ omit: ["exp"] })))).toContain(
		"exp",
	);
	expect(await refusal(verify(await idp.sign({ omit: ["sub"] })))).toContain(
		"sub",
	);
	await refusal(verify(await idp.sign({ unknownKey: true })));
	await refusal(verify("not.a.token"));
	await refusal(verify(""));
});

test("refuses an algorithm outside the allowlist, and an unsigned token", async () => {
	const verify = verifier({ algorithms: ["RS256"] });
	expect(await refusal(verify(await idp.sign({ alg: "ES256" })))).toContain(
		"alg",
	);
	const unsigned = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(
		JSON.stringify({
			iss: idp.issuer,
			aud: idp.audience,
			sub: "x",
			exp: Math.floor(Date.now() / 1000) + 60,
		}),
	).toString("base64url")}.`;
	await refusal(verify(unsigned));
});

test("refuses a symmetric or unsigned algorithm in the allowlist at construction", () => {
	expect(() => verifier({ algorithms: ["HS256"] })).toThrow("HS256");
	expect(() => verifier({ algorithms: ["none"] })).toThrow("none");
	expect(() => verifier({ algorithms: [] })).toThrow("algorithms");
});

test("refuses a configuration without issuers, audiences, or an https JWKS outside loopback", () => {
	expect(() => verifier({ issuers: [] })).toThrow("issuers");
	expect(() => verifier({ audiences: [] })).toThrow("audiences");
	expect(() => verifier({ jwksUrl: "http://keys.example.test/keys" })).toThrow(
		"https",
	);
});

test("with several issuers, one canonical issuer makes the speaker id, so one person keeps one id", async () => {
	const legacy = "https://sts.example.test/tenant/";
	expect(() => verifier({ issuers: [idp.issuer, legacy] })).toThrow(
		"speakerIssuer",
	);
	const verify = verifier({
		issuers: [idp.issuer, legacy],
		speakerIssuer: idp.issuer,
	});
	const a = await verify(await idp.sign());
	const b = await verify(await idp.sign({ claims: { iss: legacy } }));
	expect(a.id).toBe(b.id);
	expect(() =>
		verifier({ issuers: [idp.issuer], speakerIssuer: "https://x.test" }),
	).toThrow("speakerIssuer");
});

test("the subject, name, and roles claims are configurable, and a further check can refuse", async () => {
	const verify = verifier({
		subjectClaim: "oid",
		nameClaim: "preferred_username",
		rolesClaim: "groups",
		check: (claims) => claims.tid === "tenant",
	});
	const identity = await verify(
		await idp.sign({
			claims: {
				oid: "object-9",
				preferred_username: "ada@example.test",
				groups: ["g1", 7, "g2"],
				tid: "tenant",
			},
		}),
	);
	expect(identity.id).toBe(oidcSpeakerId(idp.issuer, "object-9"));
	expect(identity.name).toBe("ada@example.test");
	expect(identity.roles).toEqual(["g1", "g2"]);
	expect(
		await refusal(verify(await idp.sign({ claims: { oid: "o", tid: "x" } }))),
	).toContain("check");
	expect(await refusal(verify(await idp.sign()))).toContain("oid");
});

test("a name falls back to preferred_username, then to the subject", async () => {
	const verify = verifier();
	expect(
		(
			await verify(
				await idp.sign({
					omit: ["name"],
					claims: { preferred_username: "ada@example.test" },
				}),
			)
		).name,
	).toBe("ada@example.test");
	expect((await verify(await idp.sign({ omit: ["name"] }))).name).toBe(
		"subject-1",
	);
});

test("a rotated key set is fetched again for a token signed by the new key, once the cooldown passed", async () => {
	const verify = verifier({ refetchCooldownMs: 0 });
	await verify(await idp.sign());
	await idp.rotate();
	await verify(await idp.sign());
	expect(idp.fetches).toBe(2);
});

test("by default refuses a token with no scope or roles, as an ID token for this API's client id would be", async () => {
	const verify = verifier();
	const bare = await idp.sign({ omit: ["roles"] });
	expect(await refusal(verify(bare))).toContain("no scope or roles");
	for (const claims of [
		{ scp: "Chat.Access" },
		{ scope: "openid chat" },
		{ scp: ["Chat.Access"] },
	]) {
		const token = await idp.sign({ omit: ["roles"], claims });
		expect((await verify(token)).id).toBe(
			oidcSpeakerId(idp.issuer, "subject-1"),
		);
	}
	for (const claims of [{ scp: "" }, { scope: "  " }, { roles: [] }]) {
		const token = await idp.sign({ omit: ["roles"], claims });
		expect(await refusal(verify(token))).toContain("no scope or roles");
	}
	// Allowed for a provider whose access tokens carry neither.
	expect((await verifier({ requireScopeOrRoles: false })(bare)).roles).toEqual(
		[],
	);
});

test("by default refuses an app-only token, one with no person behind it", async () => {
	const app = await idp.sign({ claims: { idtyp: "app" } });
	expect(await refusal(verifier()(app))).toContain("app-only");
	const user = await idp.sign({ claims: { idtyp: "user" } });
	expect((await verifier()(user)).name).toBe("Ada");
	expect((await verifier({ rejectAppOnly: false })(app)).name).toBe("Ada");
});
