/** The most a picture may weigh. */
export const PICTURE_MAX_BYTES = 2 * 1024 * 1024;
const PICTURE_BUDGET_MS = 5_000;

/** A picture the proxy accepted: its bytes and the type they really are. */
export interface Picture {
	bytes: Uint8Array;
	type: string;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The type a body's first bytes show, for the four accepted formats. */
function sniff(bytes: Uint8Array): string | undefined {
	const starts = (...values: number[]) =>
		values.every((value, i) => bytes[i] === value);
	if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
		return "image/png";
	if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
	if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
	if (
		starts(0x52, 0x49, 0x46, 0x46) &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	)
		return "image/webp";
	return undefined;
}

/** Reads a body up to the cap; undefined when it is longer. */
async function readCapped(response: Response): Promise<Uint8Array | undefined> {
	const length = Number(response.headers.get("content-length"));
	if (Number.isFinite(length) && length > PICTURE_MAX_BYTES) {
		await response.body?.cancel().catch(() => undefined);
		return undefined;
	}
	const reader = response.body?.getReader();
	if (!reader) return undefined;
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > PICTURE_MAX_BYTES) {
			await reader.cancel().catch(() => undefined);
			return undefined;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.byteLength;
	}
	return bytes;
}

/**
 * Fetches a picture for the proxy: only an `https` address on one of the allowed hosts, no
 * redirect followed, only PNG, JPEG, GIF or WebP whose header and first bytes agree (so an SVG is
 * refused), at most 2 MiB. Undefined for anything else, a failure included.
 */
export async function fetchPicture(
	address: string,
	hosts: readonly string[],
	fetchImpl: Fetch = fetch,
): Promise<Picture | undefined> {
	const url = URL.parse(address);
	if (!url) return undefined;
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.port !== "" ||
		!hosts.some((host) => host.toLowerCase() === url.hostname)
	)
		return undefined;
	try {
		const response = await fetchImpl(url.href, {
			redirect: "manual",
			signal: AbortSignal.timeout(PICTURE_BUDGET_MS),
			headers: { accept: "image/png,image/jpeg,image/gif,image/webp" },
		});
		if (response.status !== 200) {
			await response.body?.cancel().catch(() => undefined);
			return undefined;
		}
		const declared = (response.headers.get("content-type") ?? "")
			.split(";")[0]
			?.trim()
			.toLowerCase();
		const bytes = await readCapped(response);
		if (!bytes) return undefined;
		const type = sniff(bytes);
		return type && type === declared ? { bytes, type } : undefined;
	} catch {
		return undefined;
	}
}

/** The proxy's answer: `nosniff`, kept by the one browser for an hour. */
export function pictureResponse(picture: Picture): Response {
	return new Response(picture.bytes, {
		headers: {
			"content-type": picture.type,
			"content-length": String(picture.bytes.byteLength),
			"x-content-type-options": "nosniff",
			"cache-control": "private, max-age=3600",
		},
	});
}
