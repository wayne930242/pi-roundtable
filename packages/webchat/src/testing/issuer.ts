import {
	type CryptoKey,
	exportJWK,
	generateKeyPair,
	type JWK,
	type JWTPayload,
	SignJWT,
} from "jose";

/** A token to sign: the claims, and how to sign them. */
export interface TokenSpec {
	/** Claims over the issuer's defaults (iss, aud, sub, name, roles, iat, exp an hour ahead). */
	claims?: JWTPayload & Record<string, unknown>;
	/** Claims to leave out of the defaults. */
	omit?: readonly string[];
	/** Default RS256, the issuer's main key. */
	alg?: "RS256" | "ES256";
	/** Signs with a key the JWKS does not publish. */
	unknownKey?: boolean;
}

/** A self-made OpenID provider: signing keys and a JWKS served on a local port. */
export interface TestIssuer {
	readonly issuer: string;
	readonly audience: string;
	readonly jwksUrl: string;
	/** How many times the JWKS was fetched. */
	readonly fetches: number;
	sign(spec?: TokenSpec): Promise<string>;
	/** Publishes a fresh key set without the old keys, as a provider rotating its keys. */
	rotate(): Promise<void>;
	close(): Promise<void>;
}

interface KeyPair {
	kid: string;
	alg: "RS256" | "ES256";
	privateKey: CryptoKey;
	jwk: JWK;
}

async function keyPair(alg: "RS256" | "ES256", kid: string): Promise<KeyPair> {
	const { privateKey, publicKey } = await generateKeyPair(alg, {
		extractable: true,
	});
	return {
		kid,
		alg,
		privateKey,
		jwk: { ...(await exportJWK(publicKey)), kid, alg, use: "sig" },
	};
}

let generation = 0;

/** Starts a provider on 127.0.0.1 with an RS256 and an ES256 key. */
export async function testIssuer(
	options: { issuer?: string; audience?: string } = {},
): Promise<TestIssuer> {
	let keys = [
		await keyPair("RS256", `rs-${++generation}`),
		await keyPair("ES256", `es-${generation}`),
	];
	const stray = await keyPair("RS256", "stray");
	let fetches = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => {
			fetches += 1;
			return Response.json({ keys: keys.map((key) => key.jwk) });
		},
	});
	const issuer = options.issuer ?? "https://login.example.test/tenant/v2.0";
	const audience = options.audience ?? "api://webchat-test";
	return {
		issuer,
		audience,
		jwksUrl: `http://127.0.0.1:${server.port}/keys`,
		get fetches() {
			return fetches;
		},
		async sign(spec = {}) {
			const alg = spec.alg ?? "RS256";
			const key = spec.unknownKey
				? stray
				: (keys.find((k) => k.alg === alg) as KeyPair);
			const now = Math.floor(Date.now() / 1000);
			const claims: Record<string, unknown> = {
				iss: issuer,
				aud: audience,
				sub: "subject-1",
				name: "Ada",
				roles: ["Chat.User"],
				iat: now,
				exp: now + 3600,
				...spec.claims,
			};
			for (const name of spec.omit ?? []) delete claims[name];
			return new SignJWT(claims)
				.setProtectedHeader({ alg, kid: key.kid, typ: "JWT" })
				.sign(key.privateKey);
		},
		async rotate() {
			keys = [
				await keyPair("RS256", `rs-${++generation}`),
				await keyPair("ES256", `es-${generation}`),
			];
		},
		close: () => server.stop(true),
	};
}
