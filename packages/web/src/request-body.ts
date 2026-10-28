/**
 * A request's whole body, read in chunks so one past `limit` bytes is refused without being held
 * whole: by its declared length first, then by the bytes that arrive. Undefined when it is over.
 */
export async function readLimited(
	request: Request,
	limit: number,
): Promise<Buffer | undefined> {
	if (Number(request.headers.get("content-length") ?? 0) > limit)
		return undefined;
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (request.body)
		for await (const chunk of request.body) {
			size += chunk.byteLength;
			if (size > limit) return undefined;
			chunks.push(chunk);
		}
	return Buffer.concat(chunks);
}
