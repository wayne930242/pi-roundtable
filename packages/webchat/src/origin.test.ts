import { expect, test } from "bun:test";
import { normalizeOrigin } from "./origin.ts";

test("a browser's origin is kept as the serialized scheme, host and port, lower-cased", () => {
	expect(normalizeOrigin("https://chat.example.com")).toBe(
		"https://chat.example.com",
	);
	expect(normalizeOrigin(" HTTPS://Chat.Example.com:8443 ")).toBe(
		"https://chat.example.com:8443",
	);
	expect(
		normalizeOrigin("chrome-extension://abcdefghijklmnopabcdefghijklmnop"),
	).toBe("chrome-extension://abcdefghijklmnopabcdefghijklmnop");
});

test("an absent, opaque or malformed origin is none", () => {
	for (const value of [
		null,
		"",
		"   ",
		"null",
		"chat.example.com",
		"https://",
		"https://chat.example.com/path",
		"https://chat.example.com?x=1",
		"https://chat example.com",
		"javascript:alert(1)",
		`https://${"a".repeat(300)}.example.com`,
	])
		expect(normalizeOrigin(value)).toBeUndefined();
});
