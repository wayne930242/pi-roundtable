import { expect, test } from "bun:test";
import { assertImagePixelBudget } from "./image-budget.ts";
import { ImagePreparationError } from "./image-preparation-error.ts";

const budget = 64_000_000;
function png(width: number, height: number): Buffer {
	const bytes = Buffer.alloc(33);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
	bytes.writeUInt32BE(13, 8);
	bytes.write("IHDR", 12);
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return bytes;
}
function jpeg(width: number, height: number, marker: number): Buffer {
	const bytes = Buffer.from([0xff, 0xd8, 0xff, marker, 0, 8, 8, 0, 0, 0, 0, 1]);
	bytes.writeUInt16BE(height, 7);
	bytes.writeUInt16BE(width, 9);
	return bytes;
}
function webpChunk(type: string, data: Buffer): Buffer {
	const header = Buffer.alloc(8);
	header.write(type);
	header.writeUInt32LE(data.length, 4);
	return Buffer.concat([
		header,
		data,
		...(data.length & 1 ? [Buffer.from([0])] : []),
	]);
}
function webp(...chunks: Buffer[]): Buffer {
	const body = Buffer.concat(chunks),
		header = Buffer.alloc(12);
	header.write("RIFF");
	header.writeUInt32LE(body.length + 4, 4);
	header.write("WEBP", 8);
	return Buffer.concat([header, body]);
}
function extended(width: number, height: number): Buffer {
	const data = Buffer.alloc(10);
	data.writeUIntLE(width - 1, 4, 3);
	data.writeUIntLE(height - 1, 7, 3);
	return webpChunk("VP8X", data);
}
function lossless(width: number, height: number): Buffer {
	const data = Buffer.alloc(5);
	data[0] = 0x2f;
	data.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
	return webpChunk("VP8L", data);
}
function lossy(width: number, height: number): Buffer {
	const data = Buffer.alloc(10);
	Buffer.from([0x9d, 0x01, 0x2a]).copy(data, 3);
	data.writeUInt16LE(width, 6);
	data.writeUInt16LE(height, 8);
	return webpChunk("VP8 ", data);
}
function frame(width: number, height: number, encoded: Buffer): Buffer {
	const data = Buffer.alloc(16);
	data.writeUIntLE(width - 1, 6, 3);
	data.writeUIntLE(height - 1, 9, 3);
	return webpChunk("ANMF", Buffer.concat([data, encoded]));
}

test("PNG pixel budget admits the exact boundary and rejects zero or over-budget headers", () => {
	expect(() => assertImagePixelBudget(png(8000, 8000), budget)).not.toThrow();
	expect(() => assertImagePixelBudget(png(9000, 1), budget)).not.toThrow();
	expect(() => assertImagePixelBudget(png(12000, 12000), budget)).toThrow(
		"64 MP",
	);
	expect(() => assertImagePixelBudget(png(0, 1), budget)).toThrow(
		ImagePreparationError,
	);
});
for (const marker of [
	0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]) {
	test(`JPEG SOF ${marker.toString(16)} is bounded before native decoding`, () => {
		expect(() =>
			assertImagePixelBudget(jpeg(8000, 6000, marker), budget),
		).not.toThrow();
		expect(() =>
			assertImagePixelBudget(jpeg(12000, 12000, marker), budget),
		).toThrow("64 MP");
	});
}
test("JPEG metadata markers are skipped, never confused with frame dimensions", () => {
	const frame = jpeg(8, 8, 0xc0);
	const bytes = Buffer.concat([
		frame.subarray(0, 2),
		Buffer.from([0xff, 0xe1, 0, 4, 0, 0]),
		frame.subarray(2),
	]);
	expect(() => assertImagePixelBudget(bytes, budget)).not.toThrow();
	bytes.writeUInt16BE(65535, 4);
	expect(() => assertImagePixelBudget(bytes, budget)).toThrow(
		ImagePreparationError,
	);
});
test("WebP simple and extended headers and all animation frames share the pixel budget", () => {
	for (const chunk of [
		lossless(8000, 6000),
		lossy(8000, 6000),
		extended(8000, 8000),
	])
		expect(() => assertImagePixelBudget(webp(chunk), budget)).not.toThrow();
	for (const chunk of [
		lossless(12000, 12000),
		lossy(12000, 12000),
		extended(12000, 12000),
	])
		expect(() => assertImagePixelBudget(webp(chunk), budget)).toThrow("64 MP");
	const bitmap = lossless(8000, 6000);
	expect(() =>
		assertImagePixelBudget(
			webp(extended(1, 1), frame(1, 1, lossless(12000, 12000))),
			budget,
		),
	).toThrow("64 MP");
	expect(() =>
		assertImagePixelBudget(
			webp(
				extended(8000, 6000),
				frame(8000, 6000, bitmap),
				frame(8000, 6000, bitmap),
			),
			budget,
		),
	).toThrow("64 MP");
});
test("truncated and non-raster headers fail without native decoding", () => {
	for (const valid of [png(8, 8), jpeg(8, 8, 0xc0), webp(lossless(8, 8))]) {
		for (let size = 0; size < Math.min(valid.length, 24); size++)
			expect(() =>
				assertImagePixelBudget(valid.subarray(0, size), budget),
			).toThrow();
	}
	expect(() =>
		assertImagePixelBudget(
			Buffer.from("<svg width='12000' height='12000'/>"),
			budget,
		),
	).toThrow(ImagePreparationError);
});
