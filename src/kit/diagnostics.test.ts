import { expect, test } from "bun:test";
import { scrubDiagnostic } from "./diagnostics.ts";

test("masks URL userinfo, bearer values, token shapes and secret-named assignments", () => {
	const text = [
		"fatal: unable to access 'https://user:hunter2@github.com/o/r.git/': 403",
		"Authorization: Bearer abcdefghijklmnop",
		`token ${"ghp"}_${"0123456789abcdefghijABCDEFGHIJ0123"}`,
		"GH_TOKEN=abc123def456 failed",
		`key ${"sk"}-${"ant-0123456789abcdefghij"}`,
	].join("\n");
	const clean = scrubDiagnostic(text);
	for (const secret of [
		"hunter2",
		"abcdefghijklmnop",
		"ghp_0123456789",
		"abc123def456",
		"sk-ant-0123",
	])
		expect(clean).not.toContain(secret);
	expect(clean).toContain("fatal: unable to access");
	expect(clean).toContain("403");
});

test("keeps ordinary text, drops control characters and bounds the length", () => {
	expect(scrubDiagnostic("remote: Repository not found.\n")).toBe(
		"remote: Repository not found.",
	);
	expect(scrubDiagnostic("a\u0000b\u001b[31mred")).toBe("a b [31mred");
	expect(scrubDiagnostic("x".repeat(2000), 100)).toHaveLength(100);
	expect(scrubDiagnostic("")).toBe("");
});
