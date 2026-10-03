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

test("leaves ordinary text alone, token counts and settings included", () => {
	for (const text of [
		'{"type":"error","message":"max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for this model"}',
		'{"usage":{"input_tokens":1200,"output_tokens":30}}',
		"context_window_tokens=200000 exceeded",
		"password_policy=strict failed",
		"Basic authentication is not supported",
		"Bearer authentication is not supported here",
		"prompt is too long: 210000 tokens > 200000 maximum",
		"remote: Invalid username or password.",
		"fatal: Authentication failed for 'https://github.com/o/r.git/'",
		"token_count=12 limit=40",
	])
		expect(scrubDiagnostic(text, 100_000)).toBe(text);
});

test("still masks a credential that follows a setting, in any value position", () => {
	const clean = scrubDiagnostic(
		[
			"x=1?token=abc999def",
			"Basic dXNlcjpwYXNzd29yZA==",
			"Bearer abc123def456ghi",
			"aws_secret_access_key=wJalrXUtnFEMI123",
			'{"usage":{"input_tokens":5},"api_key":"zzz111yyy"}',
			"passwords=hunter2x",
		].join("\n"),
		100_000,
	);
	for (const secret of [
		"abc999def",
		"dXNlcjpwYXNzd29yZA",
		"abc123def456ghi",
		"wJalrXUtnFEMI123",
		"zzz111yyy",
		"hunter2x",
	])
		expect(clean).not.toContain(secret);
	expect(clean).toContain('"input_tokens":5');
});

test("a value that holds brackets, blanks or separators is masked whole when it is quoted", () => {
	const clean = scrubDiagnostic(
		[
			'{"password":"Xy7}k9#Q"}',
			'{"client_secret":"a]b[c"}',
			"password='hunter 2'",
			'api_key="one,two&three;four"',
		].join("\n"),
	);
	expect(clean).toBe(
		[
			'{"password":"[redacted]"}',
			'{"client_secret":"[redacted]"}',
			"password='[redacted]'",
			'api_key="[redacted]"',
		].join("\n"),
	);
});

test("a value an earlier rule masked is not masked twice", () => {
	const gh = `ghp_${"0123456789abcdefghijABCDEFGHIJ0123"}`;
	expect(scrubDiagnostic(`GITHUB_TOKEN=${gh} and x-api-key: abcdef`)).toBe(
		"GITHUB_TOKEN=[redacted] and x-api-key: [redacted]",
	);
});

test("a value an earlier rule masked only the head of is masked to its end", () => {
	const gh = `ghp_${"0123456789abcdefghijABCDEFGHIJ0123"}`;
	const sk = "sk-abcdefghijklmnop";
	const cases: [string, string][] = [
		[`{"password":"${gh} with space"}`, '{"password":"[redacted]"}'],
		[`{"password":"${sk}!@#tail"}`, '{"password":"[redacted]"}'],
		[`password=${sk}!tail`, "password=[redacted]"],
		[`GITHUB_TOKEN=${gh}!tail`, "GITHUB_TOKEN=[redacted]"],
		["password=https://u:pw@host/x", "password=[redacted]"],
		[`secret=${sk}!tail and more`, "secret=[redacted] and more"],
	];
	for (const [input, expected] of cases)
		expect(scrubDiagnostic(input)).toBe(expected);
	for (const input of cases.map(([i]) => i))
		expect(scrubDiagnostic(input)).not.toContain("]]");
});

test("a JWT is still masked after a space, an equals sign, a quote or a dot", () => {
	const jwt = [
		"eyJhbGciOiJIUzI1NiJ9",
		"eyJzdWIiOiIxMjM0NTY3ODkwIn0",
		"abcdefghij12345",
	].join(".");
	for (const before of [" ", "=", '"', ".", ":"])
		expect(scrubDiagnostic(`x${before}${jwt}`)).not.toContain("eyJzdWIi");
});

function base64url(length: number): string {
	const alphabet =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	let state = 12345;
	let out = "";
	for (let i = 0; i < length; i++) {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		out += alphabet[state % alphabet.length];
	}
	return out;
}

const HOSTILE: [string, string][] = [
	["dashes", "a-".repeat(500_000)],
	["dots", "a.".repeat(500_000)],
	["token", "token".repeat(200_000)],
	["base64url", base64url(400_000)],
	[
		"dashed uuids",
		Array.from({ length: 11_000 }, () => crypto.randomUUID()).join("-"),
	],
	["schemes", "x://".repeat(100_000)],
	["assignments", "a=".repeat(300_000)],
	["spaces", `a${" ".repeat(500_000)}b`],
	["secret names", "token-secret-password=".repeat(50_000)],
	["jwt starts", "eyJ-".repeat(100_000)],
	["redacted units", "password=[redacted]".repeat(60_000)],
	["redacted then tail", "token=[redacted][redacted]x ".repeat(40_000)],
	["jwt starts glued", `${"eyJaaaaaaaaa-".repeat(30_000)}`],
	["unclosed quotes", 'password="x'.repeat(40_000)],
	["quoted tokens", "token=\"1 token='2 ".repeat(30_000)],
];

for (const max of [600, 100_000, Number.POSITIVE_INFINITY])
	test(`hostile input stays fast at a bound of ${max}`, () => {
		for (const [name, text] of HOSTILE) {
			const started = performance.now();
			scrubDiagnostic(text, max);
			const took = performance.now() - started;
			if (took > 2000) throw new Error(`${name} took ${Math.round(took)} ms`);
		}
	});
