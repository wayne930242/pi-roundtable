import type { WorkspaceMedia } from "../api-types.ts";

const startsWith = (head: Uint8Array, offset: number, text: string): boolean =>
	[...text].every((char, i) => head[offset + i] === char.charCodeAt(0));
const startsWithBytes = (head: Uint8Array, bytes: number[]): boolean =>
	bytes.every((byte, i) => head[i] === byte);
/** An ISO base media file (MP4, M4A, MOV, AVIF): `ftyp` after a four-byte size. */
const hasFtyp = (head: Uint8Array): boolean => startsWith(head, 4, "ftyp");

/** What a preview shows and the type the route answers with; the type comes from here, never from the file. */
interface MediaType {
	kind: WorkspaceMedia;
	type: string;
	/** Whether the file's first bytes are those of the kind its name claims. */
	is(head: Uint8Array): boolean;
}

const RIFF_WAVE = (head: Uint8Array) =>
	startsWith(head, 0, "RIFF") && startsWith(head, 8, "WAVE");
const EBML = (head: Uint8Array) =>
	startsWithBytes(head, [0x1a, 0x45, 0xdf, 0xa3]);
const JPEG = (head: Uint8Array) => startsWithBytes(head, [0xff, 0xd8, 0xff]);
const OGG = (head: Uint8Array) => startsWith(head, 0, "OggS");
const MP4 = (type: string, kind: "audio" | "video"): MediaType => ({
	kind,
	type,
	is: hasFtyp,
});

/** By extension; a name alone never previews, the bytes must agree. SVG alone has no signature. */
const MEDIA_BY_EXTENSION: Record<string, MediaType> = {
	png: {
		kind: "image",
		type: "image/png",
		is: (head) =>
			startsWithBytes(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	},
	jpg: { kind: "image", type: "image/jpeg", is: JPEG },
	jpeg: { kind: "image", type: "image/jpeg", is: JPEG },
	gif: {
		kind: "image",
		type: "image/gif",
		is: (head) =>
			startsWith(head, 0, "GIF87a") || startsWith(head, 0, "GIF89a"),
	},
	webp: {
		kind: "image",
		type: "image/webp",
		is: (head) => startsWith(head, 0, "RIFF") && startsWith(head, 8, "WEBP"),
	},
	avif: {
		kind: "image",
		type: "image/avif",
		is: (head) =>
			hasFtyp(head) &&
			(startsWith(head, 8, "avif") || startsWith(head, 8, "avis")),
	},
	bmp: {
		kind: "image",
		type: "image/bmp",
		is: (head) => startsWith(head, 0, "BM"),
	},
	ico: {
		kind: "image",
		type: "image/x-icon",
		is: (head) =>
			startsWithBytes(head, [0, 0, 1, 0]) ||
			startsWithBytes(head, [0, 0, 2, 0]),
	},
	svg: {
		kind: "image",
		type: "image/svg+xml",
		is: (head) =>
			!head.includes(0) &&
			Buffer.from(head).toString("latin1").includes("<svg"),
	},
	pdf: {
		kind: "pdf",
		type: "application/pdf",
		is: (head) => Buffer.from(head.subarray(0, 1024)).includes("%PDF-"),
	},
	mp3: {
		kind: "audio",
		type: "audio/mpeg",
		is: (head) =>
			startsWith(head, 0, "ID3") ||
			(head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0),
	},
	m4a: MP4("audio/mp4", "audio"),
	aac: {
		kind: "audio",
		type: "audio/aac",
		is: (head) => head[0] === 0xff && ((head[1] ?? 0) & 0xf0) === 0xf0,
	},
	ogg: { kind: "audio", type: "audio/ogg", is: OGG },
	opus: { kind: "audio", type: "audio/ogg", is: OGG },
	wav: { kind: "audio", type: "audio/wav", is: RIFF_WAVE },
	flac: {
		kind: "audio",
		type: "audio/flac",
		is: (head) => startsWith(head, 0, "fLaC"),
	},
	weba: { kind: "audio", type: "audio/webm", is: EBML },
	mp4: MP4("video/mp4", "video"),
	m4v: MP4("video/mp4", "video"),
	mov: MP4("video/quicktime", "video"),
	webm: { kind: "video", type: "video/webm", is: EBML },
};

const RASTER_BY_SIGNATURE = ["png", "jpg", "gif", "webp"] as const;

/** The preview a file is, by its first bytes for the four common pictures and by name and bytes for the rest. */
export function mediaOf(name: string, head: Uint8Array): MediaType | undefined {
	for (const extension of RASTER_BY_SIGNATURE) {
		const found = MEDIA_BY_EXTENSION[extension];
		if (found?.is(head)) return found;
	}
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return undefined;
	const found = MEDIA_BY_EXTENSION[name.slice(dot + 1).toLowerCase()];
	return found?.is(head) ? found : undefined;
}

/** Extensions that a browser would run or render as a page: always downloads. */
export const ACTIVE = new Set(["html", "htm", "xhtml", "xml", "xsl", "mht"]);

/**
 * What a preview may load: an image or a sound from the place itself. A picture, a sound and a video
 * are sandboxed, so nothing in them runs even when the address is opened on its own; a PDF is not,
 * because the browser's viewer does not run under a sandbox.
 */
export const MEDIA_POLICY =
	"sandbox; frame-ancestors 'self'; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
export const PDF_POLICY =
	"frame-ancestors 'self'; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
