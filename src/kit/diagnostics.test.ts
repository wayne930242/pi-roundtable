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

test("masks the other common credential shapes", () => {
	const jwt = [
		"eyJhbGciOiJIUzI1NiJ9",
		"eyJzdWIiOiIxMjM0NTY3ODkwIn0",
		"SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
	].join(".");
	const text = [
		"GET /v1?access_token=aaa111bbb&page=2",
		'{"refresh_token":"ccc222ddd","id":7}',
		"password=eee333",
		"x-api-key: fff444",
		"Cookie: session=ggg555; theme=dark",
		"token: hhh666",
		"client_secret: iii777",
		jwt,
	].join("\n");
	const clean = scrubDiagnostic(text);
	for (const secret of [
		"aaa111bbb",
		"ccc222ddd",
		"eee333",
		"fff444",
		"ggg555",
		"hhh666",
		"iii777",
		"SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
	])
		expect(clean).not.toContain(secret);
	expect(clean).toContain("page=2");
	expect(clean).toContain('"id":7');
});

test("hostile input stays fast", () => {
	const started = performance.now();
	scrubDiagnostic("a.".repeat(200_000), 600);
	scrubDiagnostic("x://".repeat(100_000), 600);
	expect(performance.now() - started).toBeLessThan(200);
});
