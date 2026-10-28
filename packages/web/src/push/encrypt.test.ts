import { expect, test } from "bun:test";
import type { webcrypto } from "node:crypto";
import { aes128gcm, type Bytes, encryptPayload } from "./encrypt.ts";

// RFC 8291 Appendix A: the inputs of the example and the 86-octet header and ciphertext it produces.
const b64 = (text: string) =>
	Buffer.from(text.replaceAll(/\s/g, ""), "base64url");
const PLAINTEXT = b64(
	"V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
);
const AS_PUBLIC = b64(
	"BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
);
const AS_PRIVATE = b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw");
const UA_PUBLIC = b64(
	"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
);
const UA_PRIVATE = b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94");
const SALT = b64("DGv6ra1nlYgDCS1FRnbzlw");
const AUTH_SECRET = b64("BTBZMqHH6r4Tts7J_aSIgg");
const HEADER = b64(
	"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
);
const CIPHERTEXT = b64(
	"8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
);

const jwk = (secret: Bytes, point: Bytes): webcrypto.JsonWebKey => ({
	kty: "EC",
	crv: "P-256",
	d: Buffer.from(secret).toString("base64url"),
	x: Buffer.from(point.subarray(1, 33)).toString("base64url"),
	y: Buffer.from(point.subarray(33, 65)).toString("base64url"),
});

test("the RFC 8291 Appendix A inputs give its exact aes128gcm body", async () => {
	const serverKey = await crypto.subtle.importKey(
		"jwk",
		jwk(AS_PRIVATE, AS_PUBLIC),
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		["deriveBits"],
	);
	const body = await aes128gcm({
		payload: PLAINTEXT,
		userPublic: UA_PUBLIC,
		authSecret: AUTH_SECRET,
		salt: SALT,
		server: { privateKey: serverKey, publicKey: AS_PUBLIC },
	});
	expect(Buffer.from(body).toString("base64url")).toBe(
		Buffer.concat([HEADER, CIPHERTEXT]).toString("base64url"),
	);
});

test("a fresh message opens with the receiver's key and carries a new salt and server key each time", async () => {
	const receiver = await crypto.subtle.importKey(
		"jwk",
		jwk(UA_PRIVATE, UA_PUBLIC),
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		["deriveBits"],
	);
	const text = new TextEncoder().encode('{"title":"Card waiting"}');
	const subscription = { p256dh: UA_PUBLIC, auth: AUTH_SECRET };
	const first = await encryptPayload(text, subscription);
	const second = await encryptPayload(text, subscription);
	expect(
		Buffer.from(first.subarray(0, 16)).equals(
			Buffer.from(second.subarray(0, 16)),
		),
	).toBe(false);
	expect(first.byteLength).toBe(86 + text.byteLength + 1 + 16);
	// The receiver's side of RFC 8188: derive the same key from the sender's public key in the header.
	const serverPublic = first.subarray(21, 86);
	expect(first[20]).toBe(65);
	const shared = await crypto.subtle.deriveBits(
		{
			name: "ECDH",
			public: await crypto.subtle.importKey(
				"raw",
				serverPublic,
				{ name: "ECDH", namedCurve: "P-256" },
				false,
				[],
			),
		},
		receiver,
		256,
	);
	const hkdf = async (
		secret: ArrayBuffer | Bytes,
		salt: Bytes,
		info: Bytes,
		bits: number,
	) =>
		new Uint8Array(
			await crypto.subtle.deriveBits(
				{ name: "HKDF", hash: "SHA-256", salt, info },
				await crypto.subtle.importKey("raw", secret, "HKDF", false, [
					"deriveBits",
				]),
				bits,
			),
		);
	const enc = new TextEncoder();
	const keyInfo = Buffer.concat([
		enc.encode("WebPush: info\0"),
		UA_PUBLIC,
		serverPublic,
	]);
	const ikm = await hkdf(shared, AUTH_SECRET, keyInfo, 256);
	const salt = first.subarray(0, 16);
	const cek = await hkdf(
		ikm,
		salt,
		enc.encode("Content-Encoding: aes128gcm\0"),
		128,
	);
	const nonce = await hkdf(
		ikm,
		salt,
		enc.encode("Content-Encoding: nonce\0"),
		96,
	);
	const opened = new Uint8Array(
		await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: nonce },
			await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]),
			first.subarray(86),
		),
	);
	expect(Buffer.from(opened.subarray(0, -1)).toString()).toBe(
		'{"title":"Card waiting"}',
	);
	expect(opened.at(-1)).toBe(2);
});

test("a payload that does not fit one record is refused", async () => {
	await expect(
		encryptPayload(new Uint8Array(4000), {
			p256dh: UA_PUBLIC,
			auth: AUTH_SECRET,
		}),
	).rejects.toThrow("too large");
});
