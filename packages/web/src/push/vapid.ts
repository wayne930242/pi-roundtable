import type { webcrypto } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SignJWT } from "jose";

/** How long a VAPID token is valid; push services accept up to 24 hours. */
const TOKEN_LIFE_SECONDS = 12 * 3600;
const ES256 = { name: "ECDSA", namedCurve: "P-256" } as const;

/** The server's VAPID identity (RFC 8292): the public key browsers subscribe against, and the key that signs for it. */
export interface Vapid {
	/** The uncompressed P-256 point, base64url: the `applicationServerKey` and the `k=` of the header. */
	publicKey: string;
	privateKey: CryptoKey;
}

interface Stored {
	publicKey: string;
	privateKey: webcrypto.JsonWebKey;
}

function parse(raw: string, path: string): Stored {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error(
			`${path} is not JSON; delete it to make a new VAPID key (every device must subscribe again)`,
		);
	}
	const stored = value as Partial<Stored> | null;
	if (
		typeof stored?.publicKey !== "string" ||
		typeof stored.privateKey?.d !== "string"
	)
		throw new Error(
			`${path} is not a VAPID key file; delete it to make a new one (every device must subscribe again)`,
		);
	return stored as Stored;
}

async function importStored(stored: Stored, path: string): Promise<Vapid> {
	let privateKey: CryptoKey;
	try {
		privateKey = await crypto.subtle.importKey(
			"jwk",
			stored.privateKey,
			ES256,
			false,
			["sign"],
		);
	} catch {
		throw new Error(
			`${path} does not hold a P-256 key; delete it to make a new one (every device must subscribe again)`,
		);
	}
	// The header's `k=` must be the key that signs, or every push service refuses the token.
	const { x, y } = stored.privateKey;
	const point =
		typeof x === "string" && typeof y === "string"
			? Buffer.concat([
					Buffer.from([4]),
					Buffer.from(x, "base64url"),
					Buffer.from(y, "base64url"),
				]).toString("base64url")
			: undefined;
	if (point !== stored.publicKey)
		throw new Error(
			`${path} holds a public key that does not belong to its private key; delete it to make a new one (every device must subscribe again)`,
		);
	return { publicKey: stored.publicKey, privateKey };
}

/**
 * The VAPID keys in `path`, made on first use with WebCrypto and kept readable by this user
 * alone. Subscriptions are bound to the public key, so the file must outlive a restart; a file
 * that cannot be read stops startup rather than being replaced.
 */
export async function loadVapid(path: string): Promise<Vapid> {
	let raw: string | undefined;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (raw !== undefined) return importStored(parse(raw, path), path);
	const pair = await crypto.subtle.generateKey(ES256, true, ["sign", "verify"]);
	const stored: Stored = {
		publicKey: Buffer.from(
			await crypto.subtle.exportKey("raw", pair.publicKey),
		).toString("base64url"),
		privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
	};
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	try {
		// `wx`: a second starter that lost the race reads the winner's file instead of replacing it.
		writeFileSync(path, `${JSON.stringify(stored)}\n`, {
			flag: "wx",
			mode: 0o600,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		return importStored(parse(readFileSync(path, "utf8"), path), path);
	}
	chmodSync(path, 0o600);
	return importStored(stored, path);
}

/** The `Authorization` header value for a push to an endpoint (RFC 8292): a token for its origin, signed by the key. */
export async function vapidAuthorization(
	vapid: Vapid,
	endpoint: string,
	subject: string,
	now: Date = new Date(),
): Promise<string> {
	const issued = Math.floor(now.getTime() / 1000);
	const token = await new SignJWT({})
		.setProtectedHeader({ alg: "ES256", typ: "JWT" })
		.setAudience(new URL(endpoint).origin)
		.setSubject(subject)
		.setExpirationTime(issued + TOKEN_LIFE_SECONDS)
		.sign(vapid.privateKey);
	return `vapid t=${token}, k=${vapid.publicKey}`;
}
