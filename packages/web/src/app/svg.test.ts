import { expect, test } from "bun:test";
import { isSvg, SVG_HEAD_BYTES } from "./svg.ts";
import { imageTypeOf } from "./uploads.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

test("an SVG is recognised by its prolog: BOM, whitespace, xml declaration, comments, doctype, then <svg", () => {
	const positives = [
		'<svg xmlns="http://www.w3.org/2000/svg"/>',
		"<svg>",
		"  \n\t<svg\nwidth='1'>",
		'<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>',
		'<?xml version="1.0"?>\n<!-- made by hand -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg/>',
		'<!doctype svg [ <!ENTITY a "b"> ]><svg/>',
		"<!-- a --><!-- b --><svg/>",
		'<svg onload="alert(1)"><script>alert(1)</script></svg>',
	];
	for (const text of positives)
		expect([text, isSvg(bytes(text))]).toEqual([text, true]);
	const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes("<svg/>")]);
	expect(isSvg(withBom)).toBe(true);
	expect(imageTypeOf(withBom)).toBe("image/svg+xml");
});

test("what only holds an <svg somewhere is not an SVG: an HTML page, plain text, a root of another name, a prolog that never ends", () => {
	const negatives = [
		"",
		"<html><body><svg/></body></html>",
		"<!DOCTYPE html><html><svg/></html>",
		"hello <svg/>",
		"<svgx/>",
		"<svg",
		"<svg:svg/>",
		"<?xml version='1.0'?>",
		"<?xml version='1.0'?><html><svg/></html>",
		"<!-- never closed <svg/>",
		"<!DOCTYPE svg [ <svg/>",
		"<math><svg/></math>",
	];
	for (const text of negatives)
		expect([text, isSvg(bytes(text))]).toEqual([text, false]);
	expect(imageTypeOf(bytes("<html><svg/></html>"))).toBeUndefined();
});

test("an SVG root in another default namespace, a prolog past the head, or UTF-16 is not an SVG", () => {
	expect(
		isSvg(bytes('<svg xmlns="http://www.w3.org/1999/xhtml"><a/></svg>')),
	).toBe(false);
	expect(isSvg(bytes("<svg xmlns='http://www.w3.org/1999/xhtml'/>"))).toBe(
		false,
	);
	expect(isSvg(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(true);
	expect(
		isSvg(
			bytes(`<!--${"x".repeat(5000)}--><svg/>`).subarray(0, SVG_HEAD_BYTES),
		),
	).toBe(false);
	const utf16 = Uint8Array.from([
		0xff,
		0xfe,
		...[..."<svg/>"].flatMap((char) => [char.charCodeAt(0), 0]),
	]);
	expect(isSvg(utf16)).toBe(false);
	expect(imageTypeOf(utf16)).toBeUndefined();
	expect(imageTypeOf(bytes("<svg/>"), false)).toBeUndefined();
});

test("the raster signatures still win and are still found", () => {
	const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	expect(imageTypeOf(png)).toBe("image/png");
	expect(imageTypeOf(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(
		"image/jpeg",
	);
});
