import { expect, test } from "bun:test";
import { keptType, markdownImageType } from "./rooms-service.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("a host's SVG keeps image/svg+xml whatever type it declared, by what its bytes are", () => {
	const svg = bytes(
		'<?xml version="1.0"?>\n<!-- comp -->\n<svg xmlns="http://www.w3.org/2000/svg"/>',
	);
	expect(keptType("image/svg+xml", svg)).toBe("image/svg+xml");
	expect(keptType("application/octet-stream", svg)).toBe("image/svg+xml");
});

test("a declared SVG whose bytes are not one is downgraded, as any other unproven image type is", () => {
	expect(keptType("image/svg+xml", bytes("<html><svg/></html>"))).toBe(
		"application/octet-stream",
	);
	expect(keptType("image/svg+xml", PNG)).toBe("image/png");
	expect(keptType("image/bmp", bytes("BM"))).toBe("application/octet-stream");
	expect(keptType("text/plain", bytes("hi"))).toBe("text/plain");
});

test("a page's Markdown image is still a PNG, JPEG or WebP: an SVG is not one", () => {
	expect(markdownImageType(bytes("<svg onload=alert(1)>"))).toBeUndefined();
	expect(markdownImageType(PNG)).toBe("image/png");
});
