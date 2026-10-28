import type { Bytes } from "../push/encrypt.ts";

export { withPushFetch } from "../push/test-fetch.ts";

/** A browser's side of a push subscription: the keys it gives the server, and the means to open what is sent. */
export interface Receiver {
	/** The body of `POST api/push/subscriptions`. */
	subscription(endpoint: string, label?: string): object;
	/** Opens an `aes128gcm` body the server posted, as the browser would. */
	open(body: Uint8Array): Promise<unknown>;
}

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const text = new TextEncoder();

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

/** Makes a receiver with fresh keys. */
export async function receiver(): Promise<Receiver> {
	const pair = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
	const publicKey = new Uint8Array(
		await crypto.subtle.exportKey("raw", pair.publicKey),
	);
	const auth = crypto.getRandomValues(new Uint8Array(16));
	return {
		subscription: (endpoint, label) => ({
			endpoint,
			keys: {
				p256dh: Buffer.from(publicKey).toString("base64url"),
				auth: Buffer.from(auth).toString("base64url"),
			},
			...(label ? { label } : {}),
		}),
		open: async (body) => {
			const salt = body.slice(0, 16);
			const serverPublic = body.slice(21, 86);
			const shared = await crypto.subtle.deriveBits(
				{
					name: "ECDH",
					public: await crypto.subtle.importKey(
						"raw",
						serverPublic,
						ECDH,
						false,
						[],
					),
				},
				pair.privateKey,
				256,
			);
			const ikm = await hkdf(
				shared,
				auth,
				new Uint8Array([
					...text.encode("WebPush: info\0"),
					...publicKey,
					...serverPublic,
				]),
				256,
			);
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
			const opened = new Uint8Array(
				await crypto.subtle.decrypt(
					{ name: "AES-GCM", iv: nonce },
					await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
						"decrypt",
					]),
					body.slice(86),
				),
			);
			return JSON.parse(new TextDecoder().decode(opened.subarray(0, -1)));
		},
	};
}

/** One post the server made to a push service. */
export interface Posted {
	url: string;
	headers: Headers;
	body: Uint8Array;
}

/** A `fetch` that records the posts and answers each with `status()`. */
export function fakePushService(status: () => number = () => 201) {
	const posts: Posted[] = [];
	const fetcher = (async (
		input: URL | string | Request,
		init?: RequestInit,
	) => {
		const url = input instanceof Request ? input.url : String(input);
		posts.push({
			url,
			headers: new Headers(init?.headers),
			body: new Uint8Array(init?.body as ArrayBuffer),
		});
		return new Response(null, { status: status() });
	}) as typeof fetch;
	return { posts, fetch: fetcher };
}
