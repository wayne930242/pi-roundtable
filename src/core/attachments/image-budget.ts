import { ImagePreparationError } from "./image-preparation-error.ts";

const invalid = () => new ImagePreparationError("invalid-image");

/** Inspect only encoded headers/blocks. Never allocate a raster or follow a media URL. */
export function assertImagePixelBudget(bytes: Buffer, budget: number): void {
	const pixels = (width: number, height: number): number => {
		if (width < 1 || height < 1) throw invalid();
		const area = width * height;
		check(area);
		return area;
	};
	const check = (area: number) => {
		if (area > budget) throw new ImagePreparationError("pixel-limit");
	};
	const need = (end: number, limit = bytes.length) => {
		if (end > limit) throw invalid();
	};
	const u24 = (at: number) => bytes.readUIntLE(at, 3);
	const blockEnd = (start: number): number => {
		let at = start;
		for (;;) {
			need(at + 1);
			const length = bytes[at++] ?? 0;
			if (!length) return at;
			at += length;
			need(at);
		}
	};

	if (
		bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
	) {
		need(24);
		if (
			bytes.readUInt32BE(8) !== 13 ||
			bytes.toString("ascii", 12, 16) !== "IHDR"
		)
			throw invalid();
		pixels(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
		return;
	}
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		let at = 2;
		while (at < bytes.length) {
			if (bytes[at++] !== 0xff) throw invalid();
			while (bytes[at] === 0xff) at++;
			need(at + 1);
			const marker = bytes[at++] ?? 0;
			if (marker === 0xda || marker === 0xd9) break;
			if (marker === 1 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7))
				continue;
			need(at + 2);
			const length = bytes.readUInt16BE(at);
			if (length < 2) throw invalid();
			need(at + length);
			if (
				marker >= 0xc0 &&
				marker <= 0xcf &&
				![0xc4, 0xc8, 0xcc].includes(marker)
			) {
				if (length < 8) throw invalid();
				pixels(bytes.readUInt16BE(at + 5), bytes.readUInt16BE(at + 3));
				return;
			}
			at += length;
		}
		throw invalid();
	}
	if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) {
		need(13);
		pixels(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
		let at =
			13 + ((bytes[10] ?? 0) & 0x80 ? 3 * (2 << ((bytes[10] ?? 0) & 7)) : 0);
		let total = 0;
		need(at);
		while (at < bytes.length) {
			const marker = bytes[at++];
			if (marker === 0x3b) {
				if (!total) throw invalid();
				return;
			}
			if (marker === 0x21) {
				need(at + 1);
				at = blockEnd(at + 1);
				continue;
			}
			if (marker !== 0x2c) throw invalid();
			need(at + 9);
			total += pixels(bytes.readUInt16LE(at + 4), bytes.readUInt16LE(at + 6));
			check(total);
			const flags = bytes[at + 8] ?? 0;
			at += 9 + (flags & 0x80 ? 3 * (2 << (flags & 7)) : 0);
			need(at + 1);
			at = blockEnd(at + 1);
		}
		throw invalid();
	}
	if (
		bytes.toString("ascii", 0, 4) === "RIFF" &&
		bytes.toString("ascii", 8, 12) === "WEBP"
	) {
		need(12);
		const end = bytes.readUInt32LE(4) + 8;
		need(end);
		if (end < 12) throw invalid();
		const chunks = (start: number, limit: number, frames: boolean): number => {
			let at = start,
				canvas = 0,
				total = 0;
			while (at < limit) {
				need(at + 8, limit);
				const type = bytes.toString("ascii", at, at + 4);
				const size = bytes.readUInt32LE(at + 4);
				const data = at + 8,
					next = data + size;
				need(next, limit);
				let area = 0;
				if (type === "VP8X") {
					need(data + 10, next);
					canvas = pixels(u24(data + 4) + 1, u24(data + 7) + 1);
				} else if (type === "VP8 ") {
					need(data + 10, next);
					if (
						!bytes
							.subarray(data + 3, data + 6)
							.equals(Buffer.from([0x9d, 0x01, 0x2a]))
					)
						throw invalid();
					area = pixels(
						bytes.readUInt16LE(data + 6) & 0x3fff,
						bytes.readUInt16LE(data + 8) & 0x3fff,
					);
				} else if (type === "VP8L") {
					need(data + 5, next);
					if (bytes[data] !== 0x2f) throw invalid();
					const bits = bytes.readUInt32LE(data + 1);
					area = pixels((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
				} else if (type === "ANMF") {
					if (!frames) throw invalid();
					need(data + 16, next);
					const declared = pixels(u24(data + 6) + 1, u24(data + 9) + 1);
					area = Math.max(declared, chunks(data + 16, next, false));
				}
				total += area;
				check(Math.max(total, canvas));
				at = next + (size & 1);
				need(at, limit);
			}
			const result = Math.max(total, canvas);
			if (!result) throw invalid();
			return result;
		};
		chunks(12, end, true);
		return;
	}
	throw invalid();
}
