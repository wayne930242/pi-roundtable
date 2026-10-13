import { expect, test } from "bun:test";
import { createCanvas, loadImage } from "canvas";
import { ImagePreparationError } from "./image-preparation-error.ts";
import { SQUARE_PNG_MAX_SIDE, squarePng } from "./square-png.ts";

/** A noisy picture, so its PNG does not shrink to nothing. */
function noisy(width: number, height: number, type: "png" | "jpeg" = "png") {
	const canvas = createCanvas(width, height);
	const context = canvas.getContext("2d");
	let seed = 7;
	for (let y = 0; y < height; y += 4)
		for (let x = 0; x < width; x += 4) {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			context.fillStyle = `rgb(${seed & 255},${(seed >> 8) & 255},${(seed >> 16) & 255})`;
			context.fillRect(x, y, 4, 4);
		}
	return type === "png"
		? canvas.toBuffer("image/png")
		: canvas.toBuffer("image/jpeg");
}

/** Only a PNG signature and an IHDR chunk that declare a size: nothing a decoder could read. */
function declaring(width: number, height: number): Buffer {
	const header = Buffer.alloc(33);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
	header.writeUInt32BE(13, 8);
	header.write("IHDR", 12, "ascii");
	header.writeUInt32BE(width, 16);
	header.writeUInt32BE(height, 20);
	return header;
}

test("a wide picture becomes a centered square of at most the default 512 pixels", async () => {
	const out = await squarePng(noisy(1200, 800));
	const image = await loadImage(out);
	expect([image.width, image.height]).toEqual([512, 512]);
});

test("size sets the side, and a smaller picture is not enlarged", async () => {
	const small = await loadImage(
		await squarePng(noisy(200, 300), { size: 1000 }),
	);
	expect([small.width, small.height]).toEqual([200, 200]);
	const chosen = await loadImage(
		await squarePng(noisy(400, 400), { size: 64 }),
	);
	expect([chosen.width, chosen.height]).toEqual([64, 64]);
});

test("a JPEG is accepted and comes out as PNG", async () => {
	const out = await squarePng(noisy(300, 300, "jpeg"), { size: 100 });
	expect([...out.subarray(1, 4)]).toEqual([80, 78, 71]);
});

test("maxBytes steps the side down until the PNG fits", async () => {
	const source = noisy(512, 512);
	const full = await squarePng(source);
	const limit = Math.floor(full.byteLength / 3);
	const out = await squarePng(source, { maxBytes: limit });
	expect(out.byteLength).toBeLessThanOrEqual(limit);
	const image = await loadImage(out);
	expect(image.width).toBeLessThan(512);
	expect(image.width).toBe(image.height);
});

test("a picture that cannot fit maxBytes throws instead of returning an oversize one", async () => {
	await expect(squarePng(noisy(512, 512), { maxBytes: 10 })).rejects.toThrow(
		RangeError,
	);
});

test("a declared side over 4096 is refused before anything is decoded, either way round", async () => {
	for (const bytes of [
		declaring(SQUARE_PNG_MAX_SIDE + 1, 10),
		declaring(10, SQUARE_PNG_MAX_SIDE + 1),
	])
		await expect(squarePng(bytes)).rejects.toMatchObject({
			name: "ImagePreparationError",
			reason: "pixel-limit",
		});
});

test("bytes of no image type are invalid-image", async () => {
	await expect(
		squarePng(new TextEncoder().encode("<svg/>")),
	).rejects.toBeInstanceOf(ImagePreparationError);
	await expect(squarePng(new Uint8Array(40))).rejects.toMatchObject({
		reason: "invalid-image",
	});
});

test("size and maxBytes must be whole numbers in range", async () => {
	const source = noisy(64, 64);
	for (const size of [0, 1.5, SQUARE_PNG_MAX_SIDE + 1, Number.NaN])
		await expect(squarePng(source, { size })).rejects.toThrow(RangeError);
	await expect(squarePng(source, { maxBytes: 0 })).rejects.toThrow(RangeError);
});

test("a WebP is refused as invalid-image, since the canvas cannot decode it", async () => {
	const webp = Buffer.alloc(40);
	webp.write("RIFF", 0, "ascii");
	webp.writeUInt32LE(32, 4);
	webp.write("WEBPVP8 ", 8, "ascii");
	await expect(squarePng(webp)).rejects.toMatchObject({
		name: "ImagePreparationError",
		reason: "invalid-image",
	});
});

test("a picture whose header passes but cannot be decoded is invalid-image", async () => {
	await expect(squarePng(declaring(10, 10))).rejects.toMatchObject({
		name: "ImagePreparationError",
		reason: "invalid-image",
	});
});

test("a side-limit refusal names the side limit, and maxSide raises it", async () => {
	await expect(squarePng(declaring(5000, 10))).rejects.toMatchObject({
		reason: "pixel-limit",
		message: expect.stringContaining("4096-pixel side limit"),
	});
	await expect(
		squarePng(declaring(5000, 10), { maxSide: 6000 }),
	).rejects.toMatchObject({ reason: "invalid-image" });
});
