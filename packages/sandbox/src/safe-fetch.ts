import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export class UnsafeUrlError extends Error {
	override name = "UnsafeUrlError";
}
/** The response declared a body over the limit. The status and headers let a caller report the size. */
export class ResponseTooLargeError extends UnsafeUrlError {
	constructor(
		message: string,
		readonly status: number,
		readonly headers: Headers,
	) {
		super(message);
	}
}
export interface ResolvedAddress {
	address: string;
	family: number;
}
export interface SafeFetchOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	maxBytes?: number;
	maxRedirects?: number;
	/**
	 * Return a redirect response instead of following it, so a caller that handles redirects
	 * itself can send each hop back through this function. Default: follow.
	 */
	followRedirects?: boolean;
	/** Trusted host request headers (never guest input); the accept-encoding header is always fixed. */
	headers?: Record<string, string>;
	/** Trusted test seam; never expose to guest input. */
	resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
	/** Trusted test seam. Production transport pins the socket lookup to this address. */
	transport?: (
		url: URL,
		address: ResolvedAddress,
		signal: AbortSignal,
		maxBytes: number,
		headers?: Record<string, string>,
	) => Promise<SafeFetchResult>;
}
export interface SafeFetchResult {
	url: string;
	status: number;
	/** The server's reason phrase, when it sent one. */
	statusText?: string;
	headers: Headers;
	data: Uint8Array;
}

/** Conservative globally routable unicast policy; deny special-purpose and transition ranges. */
export function isPublicAddress(raw: string): boolean {
	let address = raw.toLowerCase().replace(/^\[|\]$/g, "");
	if (address.includes("%")) return false;
	if (isIP(address) === 4) {
		const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
		return !(
			a === 0 ||
			a === 10 ||
			a === 127 ||
			a >= 224 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 &&
				(b === 168 ||
					(b === 0 && (c === 0 || c === 2)) ||
					(b === 88 && c === 99))) ||
			(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
			(a === 203 && b === 0 && c === 113)
		);
	}
	if (isIP(address) !== 6) return false;
	// URL canonicalization normalizes expanded IPv6 and dotted IPv4-mapped representations.
	// pi-lens-ignore: unchecked-throwing-call -- isIP validated IPv6 and scope identifiers were already refused.
	address = new URL(`http://[${address}]/`).hostname.slice(1, -1);
	if (address.startsWith("::ffff:")) {
		const parts = address.slice(7).split(":");
		if (parts.length !== 2) return false;
		const high = Number.parseInt(parts[0] ?? "", 16);
		const low = Number.parseInt(parts[1] ?? "", 16);
		return isPublicAddress(
			`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`,
		);
	}
	// Only ordinary global IPv6, excluding documentation, benchmarking, Teredo and 6to4.
	// Hextets are read numerically after expansion, so compressed forms such as 2001::1 are caught too.
	const [head = "", tail = ""] = address.split("::");
	const left = head ? head.split(":") : [];
	const right = tail ? tail.split(":") : [];
	const hextets = address.includes("::")
		? [
				...left,
				...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"),
				...right,
			]
		: left;
	const first = Number.parseInt(hextets[0] ?? "", 16);
	const second = Number.parseInt(hextets[1] ?? "", 16);
	return (
		first >= 0x2000 &&
		first <= 0x3fff &&
		first !== 0x2002 &&
		!(
			first === 0x2001 &&
			(second === 0 ||
				second === 2 ||
				second === 0xdb8 ||
				(second >= 0x10 && second <= 0x2f))
		) &&
		first !== 0x3fff
	);
}

function target(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new UnsafeUrlError("Invalid URL");
	}
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password
	)
		throw new UnsafeUrlError("Only credential-free HTTP(S) URLs are allowed");
	url.hash = "";
	return url;
}

/** No proxy environment or second DNS resolution is used; TLS still validates the original hostname. */
export async function pinnedTransport(
	url: URL,
	address: ResolvedAddress,
	signal: AbortSignal,
	maxBytes: number,
	extraHeaders: Record<string, string> = {},
): Promise<SafeFetchResult> {
	return new Promise((resolve, reject) => {
		const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
			url,
			{
				signal,
				agent: false,
				family: address.family,
				headers: {
					accept:
						"text/html,application/pdf,text/plain,application/json;q=0.9,*/*;q=0.1",
					"user-agent": "pi-roundtable-sandbox",
					...extraHeaders,
					"accept-encoding": "identity",
				},
				lookup: (_hostname, _options, callback) =>
					callback(null, address.address, address.family),
			},
			(response) => {
				const headers = new Headers();
				for (const [name, value] of Object.entries(response.headers))
					if (value !== undefined)
						headers.set(name, Array.isArray(value) ? value.join(", ") : value);
				const status = response.statusCode ?? 502;
				if ([301, 302, 303, 307, 308].includes(status)) {
					response.destroy();
					resolve({
						url: url.href,
						status,
						statusText: response.statusMessage,
						headers,
						data: new Uint8Array(),
					});
					return;
				}
				const length = Number(headers.get("content-length"));
				const encoding =
					headers.get("content-encoding")?.toLowerCase() ?? "identity";
				if (length > maxBytes) {
					response.destroy();
					reject(
						new ResponseTooLargeError(
							"Response exceeds bounds",
							status,
							headers,
						),
					);
					return;
				}
				if (!["identity", "gzip", "deflate", "br"].includes(encoding)) {
					response.destroy();
					reject(
						new UnsafeUrlError(
							"Response exceeds bounds or uses unsupported encoding",
						),
					);
					return;
				}
				const decoder =
					encoding === "gzip"
						? createGunzip()
						: encoding === "deflate"
							? createInflate()
							: encoding === "br"
								? createBrotliDecompress()
								: undefined;
				let wireBytes = 0;
				response.on("data", (chunk: Buffer) => {
					wireBytes += chunk.length;
					if (wireBytes > maxBytes) {
						response.destroy();
						decoder?.destroy();
						reject(new UnsafeUrlError("Wire body too large"));
					}
				});
				const body = decoder ? response.pipe(decoder) : response;
				const chunks: Buffer[] = [];
				let size = 0;
				body.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > maxBytes) {
						response.destroy();
						decoder?.destroy();
						reject(new UnsafeUrlError("Response body too large"));
					} else chunks.push(chunk);
				});
				response.on("error", (error) => {
					decoder?.destroy();
					reject(error);
				});
				body.on("error", (error) => {
					response.destroy();
					reject(error);
				});
				body.on("end", () => {
					// A decoded body no longer matches the length the server sent; a body sent without
					// one keeps none, so a caller reads it with its own limit as it would over fetch.
					if (decoder) headers.delete("content-length");
					headers.delete("content-encoding");
					resolve({
						url: url.href,
						status,
						statusText: response.statusMessage,
						headers,
						data: Buffer.concat(chunks, size),
					});
				});
			},
		);
		let connectTimer: ReturnType<typeof setTimeout> | undefined;
		request.on("socket", (socket) => {
			connectTimer = setTimeout(
				() =>
					request.destroy(
						Object.assign(new Error("Connection deadline exceeded"), {
							code: "ETIMEDOUT",
						}),
					),
				3000,
			);
			socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () =>
				clearTimeout(connectTimer),
			);
		});
		request.on("error", (error) => {
			clearTimeout(connectTimer);
			reject(error);
		});
		request.on("close", () => clearTimeout(connectTimer));
		request.end();
	});
}

/** Every DNS answer for the host must be a public address; a mixed answer is refused. */
async function vetAddresses(
	url: URL,
	resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>,
): Promise<readonly ResolvedAddress[]> {
	const host = url.hostname.replace(/^\[|\]$/g, "");
	const addresses = isIP(host)
		? [{ address: host, family: isIP(host) }]
		: await (
				resolve ??
				((hostname) => lookup(hostname, { all: true, verbatim: true }))
			)(host);
	if (
		!addresses.length ||
		addresses.some(
			(entry) =>
				!isPublicAddress(entry.address) || isIP(entry.address) !== entry.family,
		)
	)
		throw new UnsafeUrlError("URL resolves to a non-public address");
	return addresses;
}

/**
 * Refuse a URL that is not credential-free HTTP(S) or does not resolve only to public addresses.
 * For handing a guest-supplied URL to a third-party fetcher; it does not pin a later connection.
 */
export async function assertPublicUrl(
	raw: string,
	resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>,
): Promise<URL> {
	const url = target(raw);
	await vetAddresses(url, resolve);
	return url;
}

/** Resolve and validate every hop, then pin its actual socket to a vetted address. */
export async function safeFetch(
	raw: string,
	options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
	const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
	const timeoutMs = options.timeoutMs ?? 60_000;
	const redirects = options.maxRedirects ?? 5;
	if (
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 1 ||
		maxBytes > 32 * 1024 * 1024 ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > 120_000 ||
		!Number.isSafeInteger(redirects) ||
		redirects < 0 ||
		redirects > 10
	)
		throw new UnsafeUrlError("Invalid fetch bounds");
	const signal = AbortSignal.any([
		...(options.signal ? [options.signal] : []),
		AbortSignal.timeout(timeoutMs),
	]);
	const cancelled = new Promise<never>((_resolve, reject) => {
		if (signal.aborted) reject(signal.reason);
		else
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			});
	});
	return Promise.race([
		cancelled,
		(async () => {
			let url = target(raw);
			for (let hop = 0; ; hop++) {
				signal.throwIfAborted();
				const addresses = await vetAddresses(url, options.resolve);
				let result: SafeFetchResult | undefined;
				for (const address of addresses) {
					signal.throwIfAborted();
					try {
						result = await (options.transport ?? pinnedTransport)(
							url,
							address,
							signal,
							maxBytes,
							options.headers,
						);
						break;
					} catch (error) {
						if (
							signal.aborted ||
							!(
								error instanceof Error &&
								"code" in error &&
								[
									"ECONNREFUSED",
									"ECONNRESET",
									"EHOSTUNREACH",
									"ENETUNREACH",
									"ETIMEDOUT",
								].includes(String(error.code))
							)
						)
							throw error;
					}
				}
				if (!result)
					throw new UnsafeUrlError("No vetted address could be reached");
				if (result.data.byteLength > maxBytes)
					throw new UnsafeUrlError("Response body too large");
				if (
					options.followRedirects === false ||
					![301, 302, 303, 307, 308].includes(result.status)
				)
					return result;
				if (hop >= redirects) throw new UnsafeUrlError("Too many redirects");
				const location = result.headers.get("location");
				if (!location) throw new UnsafeUrlError("Redirect without location");
				url = target(new URL(location, url).href);
			}
		})(),
	]);
}
