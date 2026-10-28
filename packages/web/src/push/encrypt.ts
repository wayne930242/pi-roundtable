/** The size of the one record a message is sealed in (RFC 8188 `rs`). */
const RECORD_SIZE = 4096;
/** The header before the ciphertext: salt (16), record size (4), key id length (1), server key (65). */
const HEADER_BYTES = 86;
/** The AES-GCM tag and the padding delimiter. */
const OVERHEAD = 16 + 1;
/** The most plaintext bytes one record holds. */
const MAX_PAYLOAD_BYTES = RECORD_SIZE - HEADER_BYTES - OVERHEAD;

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const text = new TextEncoder();

/** A byte array WebCrypto accepts. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** The keys of a receiver's push subscription, decoded. */
export interface ReceiverKeys {
	/** The browser's public key: an uncompressed P-256 point, 65 bytes. */
	p256dh: Bytes;
	/** The browser's 16-byte authentication secret. */
	auth: Bytes;
}

/** The sender's ephemeral key pair for one message. */
export interface ServerKey {
	privateKey: CryptoKey;
	/** The uncompressed point, 65 bytes. */
	publicKey: Bytes;
}

export interface SealInput {
	payload: Bytes;
	userPublic: Bytes;
	authSecret: Bytes;
	salt: Bytes;
	server: ServerKey;
}

async function hkdf(
	secret: ArrayBuffer | Bytes,
	salt: Bytes,
	info: Bytes,
	bits: number,
): Promise<Bytes> {
	const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, [
		"deriveBits",
	]);
	return new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: "HKDF", hash: "SHA-256", salt, info },
			key,
			bits,
		),
	);
}

/**
 * Seals a payload as RFC 8291 describes for Web Push: ECDH with the browser's key, the
 * authentication secret and the two public keys combined into the input keying material, then one
 * `aes128gcm` record (RFC 8188) whose header carries the salt and the sender's public key.
 */
export async function aes128gcm(input: SealInput): Promise<Bytes> {
	const { payload, userPublic, authSecret, salt, server } = input;
	if (payload.byteLength > MAX_PAYLOAD_BYTES)
		throw new RangeError(
			`the push payload is too large: ${payload.byteLength} bytes, at most ${MAX_PAYLOAD_BYTES}`,
		);
	const receiver = await crypto.subtle.importKey(
		"raw",
		userPublic,
		ECDH,
		false,
		[],
	);
	const shared = await crypto.subtle.deriveBits(
		{ name: "ECDH", public: receiver },
		server.privateKey,
		256,
	);
	const keyInfo = new Uint8Array([
		...text.encode("WebPush: info\0"),
		...userPublic,
		...server.publicKey,
	]);
	const ikm = await hkdf(shared, authSecret, keyInfo, 256);
	const cek = await hkdf(
		ikm,
		salt,
		text.encode("Content-Encoding: aes128gcm\0"),
		128,
	);
	const nonce = await hkdf(
		ikm,
		salt,
		text.encode("Content-Encoding: nonce\0"),
		96,
	);
	// The last (here only) record ends with the delimiter 0x02.
	const record = new Uint8Array(payload.byteLength + 1);
	record.set(payload);
	record[payload.byteLength] = 2;
	const sealed = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv: nonce },
			await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]),
			record,
		),
	);
	const body = new Uint8Array(HEADER_BYTES + sealed.byteLength);
	body.set(salt, 0);
	new DataView(body.buffer).setUint32(16, RECORD_SIZE);
	body[20] = server.publicKey.byteLength;
	body.set(server.publicKey, 21);
	body.set(sealed, HEADER_BYTES);
	return body;
}

/** Seals a payload for a subscription with a random salt and a key pair made for this message alone. */
export async function encryptPayload(
	payload: Bytes,
	receiver: ReceiverKeys,
): Promise<Bytes> {
	const pair = await crypto.subtle.generateKey(ECDH, false, ["deriveBits"]);
	return aes128gcm({
		payload,
		userPublic: receiver.p256dh,
		authSecret: receiver.auth,
		salt: crypto.getRandomValues(new Uint8Array(16)),
		server: {
			privateKey: pair.privateKey,
			publicKey: new Uint8Array(
				await crypto.subtle.exportKey("raw", pair.publicKey),
			),
		},
	});
}
