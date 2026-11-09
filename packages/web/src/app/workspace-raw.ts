import { Readable } from "node:stream";
import { safeName } from "./files.ts";
import type { WorkspaceGuard } from "./workspace-guard.ts";
import {
	ACTIVE,
	MEDIA_POLICY,
	mediaOf,
	PDF_POLICY,
} from "./workspace-media.ts";
import {
	DOWNLOAD_MAX_BYTES,
	HEAD_BYTES,
	WorkspaceRefusal,
} from "./workspace-model.ts";

/** What a request says about the version and the part it wants. */
export interface RawConditions {
	/** The `Range` header. */
	range?: string | null | undefined;
	/** The `If-Range` header: the part is sent only when this is still the file's ETag. */
	ifRange?: string | null | undefined;
	/** The `If-None-Match` header. */
	ifNoneMatch?: string | null | undefined;
}

/** Whether an `If-None-Match` names this ETag (weakly, as a GET compares) or is `*`. */
function matchesEtag(header: string | null | undefined, etag: string): boolean {
	if (!header) return false;
	const bare = (tag: string) => tag.trim().replace(/^W\//, "");
	return header
		.split(",")
		.some((tag) => tag.trim() === "*" || bare(tag) === bare(etag));
}

/**
 * One plain byte range (`a-b`, `a-` or `-n`) of a file of `size` bytes; anything else is not a range
 * and the whole file is sent, which a server may always do. A start past the end is unsatisfiable.
 */
function parseRange(
	header: string | null | undefined,
	size: number,
): { start: number; end: number } | "unsatisfiable" | undefined {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
	if (!match || (match[1] === "" && match[2] === "")) return undefined;
	const first = match[1] === "" ? undefined : Number(match[1]);
	const last = match[2] === "" ? undefined : Number(match[2]);
	if (first === undefined) {
		const tail = last ?? 0;
		if (tail === 0) return "unsatisfiable";
		return { start: Math.max(0, size - tail), end: size - 1 };
	}
	if (last !== undefined && last < first) return undefined;
	if (first >= size) return "unsatisfiable";
	return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}

/** Answers a request for a file's bytes: whole or in a range, inline for a preview and as a download otherwise. */
export async function rawFile(
	guard: WorkspaceGuard,
	rootId: string,
	raw: string,
	download: boolean,
	conditions: RawConditions = {},
): Promise<Response> {
	const located = await guard.located(rootId, raw);
	const { root, segments } = located;
	const target = await guard.target(located, raw);
	if (target.info.isDirectory()) throw new WorkspaceRefusal(400, "is-a-dir");
	if (target.info.size > DOWNLOAD_MAX_BYTES)
		throw new WorkspaceRefusal(413, "too-large");
	const handle = await guard.openRegular(
		target.path,
		target.info,
		root.id,
		raw,
	);
	try {
		const info = await handle.stat();
		const head = Buffer.alloc(Math.min(HEAD_BYTES, info.size));
		await handle.read(head, 0, head.length, 0);
		const name = segments.at(-1) ?? "file";
		const media = mediaOf(name, head);
		const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
		const asText =
			!media && !head.includes(0) && !ACTIVE.has(extension) && !download;
		const inline = !download && (media !== undefined || asText);
		const encoded = encodeURIComponent(safeName(name)).replace(
			/['()*]/g,
			(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
		);
		// The size is what the open handle says now, and the stream stops there, so a file that
		// grows while it is sent cannot make the body longer than its `content-length`.
		if (info.size > DOWNLOAD_MAX_BYTES)
			throw new WorkspaceRefusal(413, "too-large");
		// Strong, so that `If-Range` may match it: the inode and the time to the nanosecond.
		const exact = await handle.stat({ bigint: true });
		const etag = `"${exact.ino.toString(16)}-${exact.size.toString(16)}-${exact.mtimeNs.toString(16)}"`;
		const headers: Record<string, string> = {
			"content-type": media
				? media.type
				: asText
					? "text/plain; charset=utf-8"
					: "application/octet-stream",
			"content-disposition": inline
				? "inline"
				: `attachment; filename*=UTF-8''${encoded}`,
			"content-security-policy": media
				? media.kind === "pdf"
					? PDF_POLICY
					: MEDIA_POLICY
				: "sandbox; frame-ancestors 'self'; default-src 'none'",
			"x-content-type-options": "nosniff",
			"accept-ranges": "bytes",
		};
		if (media && inline) {
			// A preview may be asked for again, in pieces: it is checked each time, never kept as is.
			headers["cache-control"] = "no-store";
			headers.etag = etag;
			headers["last-modified"] = new Date(info.mtimeMs).toUTCString();
		} else headers["cache-control"] = "no-store";
		if (media && inline && matchesEtag(conditions.ifNoneMatch, etag)) {
			await handle.close();
			return new Response(null, { status: 304, headers });
		}
		let start = 0;
		let end = info.size - 1;
		let status = 200;
		const range =
			info.size > 0 && (!conditions.ifRange || conditions.ifRange === etag)
				? parseRange(conditions.range, info.size)
				: undefined;
		if (range === "unsatisfiable") {
			await handle.close();
			headers["content-range"] = `bytes */${info.size}`;
			headers["content-length"] = "0";
			return new Response(null, { status: 416, headers });
		}
		if (range) {
			({ start, end } = range);
			status = 206;
			headers["content-range"] = `bytes ${start}-${end}/${info.size}`;
		}
		headers["content-length"] = String(info.size === 0 ? 0 : end - start + 1);
		let body: ReadableStream<Uint8Array> | null = null;
		if (info.size === 0) await handle.close();
		else
			body = Readable.toWeb(
				handle.createReadStream({ start, end, autoClose: true }),
			) as ReadableStream<Uint8Array>;
		return new Response(body, { status, headers });
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
}
