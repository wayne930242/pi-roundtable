import { expect, test } from "bun:test";
import { inspect } from "node:util";
import { LineApi } from "./api.ts";
import { LineApiError, LineError } from "./errors.ts";
import { CHANNEL_ID, fakeLine, SECRET, sign } from "./testing/line-fake.ts";
import { TokenSource } from "./token.ts";

const credentials = { channelId: CHANNEL_ID, channelSecret: SECRET };

function setup() {
	const line = fakeLine();
	let time = 1_000_000;
	const tokens = new TokenSource({
		credentials,
		fetch: line.fetch,
		now: () => time,
	});
	return {
		line,
		tokens,
		advance: (ms: number) => {
			time += ms;
		},
	};
}

test("it issues a stateless token with the channel id and secret, and keeps it until a minute before it lapses", async () => {
	const { line, tokens, advance } = setup();
	expect(await tokens.token()).toBe("access-token-1");
	const form = new URLSearchParams(line.calls[0]?.body);
	expect(Object.fromEntries(form)).toEqual({
		grant_type: "client_credentials",
		client_id: CHANNEL_ID,
		client_secret: SECRET,
	});
	expect(line.calls[0]?.url).toBe("https://api.line.me/oauth2/v3/token");
	advance(839_000);
	expect(await tokens.token()).toBe("access-token-1");
	advance(2_000);
	expect(await tokens.token()).toBe("access-token-2");
	expect(tokens.health().issued).toBe(2);
});

test("concurrent callers share one token request", async () => {
	const { line, tokens } = setup();
	const got = await Promise.all(
		Array.from({ length: 8 }, () => tokens.token()),
	);
	expect(new Set(got)).toEqual(new Set(["access-token-1"]));
	expect(line.issued).toHaveLength(1);
});

test("a token that lives under two minutes is replaced at half its life, not at once", async () => {
	const { line, tokens, advance } = setup();
	line.expiresIn = 100;
	await tokens.token();
	advance(40_000);
	await tokens.token();
	expect(line.issued).toHaveLength(1);
	advance(11_000);
	await tokens.token();
	expect(line.issued).toHaveLength(2);
});

test("a 401 makes the call reissue the token and repeat once; a second 401 is an error", async () => {
	const { line, tokens } = setup();
	const api = new LineApi({ tokens, fetch: line.fetch });
	expect(await api.botUserId()).toBe("Ubot-for-tests");
	line.revoke("access-token-1");
	expect(await api.botUserId()).toBe("Ubot-for-tests");
	expect(line.issued).toEqual(["access-token-1", "access-token-2"]);
	line.revoke("access-token-2");
	line.revoke("access-token-3");
	const error = await api.botUserId().catch((e: unknown) => e);
	expect(error).toBeInstanceOf(LineApiError);
	expect((error as LineApiError).status).toBe(401);
});

test("a static token is used as it is and a 401 on it is final", async () => {
	const line = fakeLine();
	const tokens = new TokenSource({
		credentials: { ...credentials, token: { static: "static-token-value" } },
		fetch: line.fetch,
	});
	const api = new LineApi({ tokens, fetch: line.fetch });
	await expect(api.botUserId()).rejects.toMatchObject({ status: 401 });
	expect(line.calls).toHaveLength(1);
	expect(line.calls[0]?.authorization).toBe("Bearer static-token-value");
});

test("the endpoint refusing is an error with a code, and the next call tries again", async () => {
	const { line, tokens } = setup();
	line.failTokens(500);
	const error = await tokens.token().catch((e: unknown) => e);
	expect(error).toBeInstanceOf(LineApiError);
	expect((error as LineApiError).code).toBe("token_refused");
	expect(tokens.health().lastFailure).toBe("token_refused");
	line.failTokens(undefined);
	expect(await tokens.token()).toBe("access-token-1");
	expect(tokens.health().lastFailure).toBeUndefined();
});

test("bad credentials stop the configuration", () => {
	for (const bad of [
		{ channelId: "abc", channelSecret: SECRET },
		{ channelId: CHANNEL_ID, channelSecret: "" },
		{ channelId: CHANNEL_ID, channelSecret: SECRET, token: { static: "" } },
	])
		expect(() => new TokenSource({ credentials: bad })).toThrow(LineError);
});

test("the signature check is constant-time on the raw bytes and refuses anything else", () => {
	const { tokens } = setup();
	const raw = '{"destination":"U1",  "events":[]}';
	const bytes = new TextEncoder().encode(raw);
	expect(tokens.verifies(bytes, sign(raw))).toBe(true);
	// The same JSON written differently is a different body.
	const reserialized = JSON.stringify(JSON.parse(raw));
	expect(
		tokens.verifies(new TextEncoder().encode(reserialized), sign(raw)),
	).toBe(false);
	expect(tokens.verifies(bytes, sign(raw, "another-secret"))).toBe(false);
	expect(tokens.verifies(bytes, "")).toBe(false);
	expect(tokens.verifies(bytes, "not base64 !!")).toBe(false);
	expect(tokens.verifies(bytes, sign(`${raw} `))).toBe(false);
});

test("neither the token nor the secret is in an error, a serialization or an inspection", async () => {
	const { line, tokens } = setup();
	const api = new LineApi({ tokens, fetch: line.fetch });
	const token = await tokens.token();
	const seen: string[] = [
		JSON.stringify(tokens),
		inspect(tokens, { depth: 5 }),
		String(tokens),
	];
	// An endpoint that echoes the request, a network error that quotes headers and body, a bad status.
	line.failTokens(500);
	const fresh = new TokenSource({ credentials, fetch: line.fetch });
	seen.push(String(await fresh.token().catch((e: unknown) => e)));
	line.failTokens(undefined);
	line.breakNetwork(true);
	seen.push(String(await api.botUserId().catch((e: unknown) => e)));
	seen.push(String(await fresh.token().catch((e: unknown) => e)));
	line.breakNetwork(false);
	line.revoke(token);
	line.revoke("access-token-2");
	seen.push(String(await api.botUserId().catch((e: unknown) => e)));
	for (const text of seen) {
		expect(text).not.toContain(SECRET);
		expect(text).not.toContain("access-token-");
	}
	expect(
		seen.some(
			(text) => text.includes("LineError") || text.includes("LineApiError"),
		),
	).toBe(true);
});
