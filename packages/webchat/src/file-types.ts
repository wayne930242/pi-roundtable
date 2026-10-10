/** The content type without parameters, lower case; undefined for a missing or empty header. */
export function baseType(header: string | null): string | undefined {
	const type = header?.split(";")[0]?.trim().toLowerCase();
	return type ? type : undefined;
}

/** Whether `type` is one of `allowed`; an entry ending in `/*` admits every type under it. */
export function isAllowedType(
	allowed: readonly string[],
	type: string,
): boolean {
	return allowed.some((entry) =>
		entry.endsWith("/*")
			? type.startsWith(entry.slice(0, -1)) && type.length > entry.length - 1
			: entry === type,
	);
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0) =>
	signature.every((byte, index) => bytes[at + index] === byte);

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/**
 * Whether the bytes are what the type says, for the types whose first bytes say so: the four
 * image formats the model reads, and PDF. Any other type has nothing to check and passes.
 */
export function bytesMatchType(type: string, bytes: Uint8Array): boolean {
	switch (type) {
		case "image/png":
			return startsWith(
				bytes,
				[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
			);
		case "image/jpeg":
			return startsWith(bytes, [0xff, 0xd8, 0xff]);
		case "image/gif":
			return (
				startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))
			);
		case "image/webp":
			return (
				startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)
			);
		case "application/pdf":
			return startsWith(bytes, ascii("%PDF-"));
		default:
			return true;
	}
}
