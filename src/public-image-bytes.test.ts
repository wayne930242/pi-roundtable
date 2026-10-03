import { expect, test } from "bun:test";
import { once } from "node:events";
import { createDeflate } from "node:zlib";
import { createCanvas, loadImage } from "canvas";
import { ImagePreparationError, prepareImageBytes } from "./kit/index.ts";

test("byte-based image preparation preserves admitted small images and downsizes oversized dimensions", async () => {
	const source = createCanvas(8, 8);
	const small = source.toBuffer("image/png");
	const jpeg = source.toBuffer("image/jpeg");
	expect(await prepareImageBytes(jpeg, "image/jpeg")).toEqual({
		data: jpeg.toString("base64"),
		mimeType: "image/jpeg",
	});
	expect(
		await prepareImageBytes(new Uint8Array(small), "image/png; charset=binary"),
	).toEqual({ data: small.toString("base64"), mimeType: "image/png" });
	const wide = createCanvas(9000, 1).toBuffer("image/png");
	const result = await prepareImageBytes(new Uint8Array(wide), "image/png");
	expect(result.mimeType).toBe("image/jpeg");
	const decoded = await loadImage(Buffer.from(result.data, "base64"));
	expect(decoded.width).toBe(2000);
	await expect(
		prepareImageBytes(new Uint8Array([1, 2, 3]), "image/png"),
	).rejects.toThrow();
});

function crc32(bytes: Buffer): number {
	let value = 0xffffffff;
	for (const byte of bytes) {
		value ^= byte;
		for (let bit = 0; bit < 8; bit++)
			value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
	}
	return (value ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
	const kind = Buffer.from(type);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([kind, data])));
	return Buffer.concat([length, kind, data, crc]);
}
/** A valid high-compression PNG, generated row-wise without a giant raw bitmap. */
async function grayscalePng(width: number, height: number): Promise<Buffer> {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	const compressed: Buffer[] = [];
	const deflate = createDeflate();
	deflate.on("data", (chunk: Buffer) => compressed.push(chunk));
	const ended = once(deflate, "end");
	const row = Buffer.alloc(width + 1);
	for (let y = 0; y < height; y++)
		if (!deflate.write(row)) await once(deflate, "drain");
	deflate.end();
	await ended;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", Buffer.concat(compressed)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

test("a small compression bomb is refused before native decoding, while a 48 MP camera image remains admitted", async () => {
	const bomb = await grayscalePng(12000, 12000);
	expect(bomb.length).toBeLessThan(200000);
	await expect(prepareImageBytes(bomb, "image/png")).rejects.toMatchObject({
		name: "ImagePreparationError",
		reason: "pixel-limit",
	});
	const ordinary = await grayscalePng(8000, 6000);
	expect(await prepareImageBytes(ordinary, "image/png")).toEqual({
		data: ordinary.toString("base64"),
		mimeType: "image/png",
	});
});

test("encoded bytes over 25 MiB are refused before header inspection or decoding", async () => {
	await expect(
		prepareImageBytes(new Uint8Array(25 * 1024 * 1024 + 1), "image/png"),
	).rejects.toMatchObject({
		name: "ImagePreparationError",
		reason: "byte-limit",
		message: "Image is larger than 25 MiB.",
	});
	expect(new ImagePreparationError("pixel-limit").message).toContain("64 MP");
});

test("GIF frame dimensions and their aggregate decoded pixels cannot hide behind a tiny logical screen", async () => {
	const gif = Buffer.from(
		"R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
		"base64",
	);
	expect(await prepareImageBytes(gif, "image/gif")).toEqual({
		data: gif.toString("base64"),
		mimeType: "image/gif",
	});
	const start = gif.indexOf(0x2c);
	const frame = Buffer.from(gif.subarray(start, gif.length - 1));
	frame.writeUInt16LE(12000, 5);
	frame.writeUInt16LE(12000, 7);
	await expect(
		prepareImageBytes(
			Buffer.concat([gif.subarray(0, start), frame, Buffer.from([0x3b])]),
			"image/gif",
		),
	).rejects.toMatchObject({ reason: "pixel-limit" });
	frame.writeUInt16LE(8000, 5);
	frame.writeUInt16LE(6000, 7);
	await expect(
		prepareImageBytes(
			Buffer.concat([
				gif.subarray(0, start),
				frame,
				frame,
				Buffer.from([0x3b]),
			]),
			"image/gif",
		),
	).rejects.toMatchObject({ reason: "pixel-limit" });
});
