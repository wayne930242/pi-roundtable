import { expect, test } from "bun:test";
import { LineApi } from "./api.ts";
import { type LineApiPort, lineApiPort } from "./api-port.ts";
import { LineApiError, LineError } from "./errors.ts";
import { QuotaGate } from "./quota.ts";
import { CHANNEL_ID, fakeLine, SECRET } from "./testing/line-fake.ts";
import { TokenSource } from "./token.ts";

const credentials = { channelId: CHANNEL_ID, channelSecret: SECRET };

function setup(options: { monthlyCap?: number; fetch?: typeof fetch } = {}): {
	line: ReturnType<typeof fakeLine>;
	port: LineApiPort;
	tokens: TokenSource;
	advance: (ms: number) => void;
} {
	const line = fakeLine();
	const doFetch = options.fetch ?? line.fetch;
	let time = new Date("2026-10-13T00:00:00Z").getTime();
	const now = () => new Date(time);
	const tokens = new TokenSource({
		credentials,
		fetch: doFetch,
		now: () => time,
	});
	const api = new LineApi({ tokens, fetch: doFetch });
	const quota = new QuotaGate({
		api,
		now,
		...(options.monthlyCap
			? { options: { monthlyCap: options.monthlyCap } }
			: {}),
	});
	return {
		line,
		port: lineApiPort({ api, tokens, quota }),
		tokens,
		advance: (ms) => {
			time += ms;
		},
	};
}

const calls = (line: ReturnType<typeof fakeLine>, prefix: string) =>
	line.calls.filter((call) => new URL(call.url).pathname.startsWith(prefix));

test("a group member's profile is read from the member endpoint, a missing picture is left out", async () => {
	const { line, port } = setup();
	line.profiles["Cgroup0001/Uone"] = {
		displayName: "Ada",
		pictureUrl: "https://pictures.example.test/ada.png",
	};
	line.profiles["Cgroup0001/Utwo"] = { displayName: "Grace", pictureUrl: "" };
	expect(await port.profile("line:group:Cgroup0001", "Uone")).toEqual({
		displayName: "Ada",
		pictureUrl: "https://pictures.example.test/ada.png",
	});
	expect(await port.profile("line:group:Cgroup0001", "Utwo")).toEqual({
		displayName: "Grace",
	});
	expect(calls(line, "/v2/bot/group")[0]?.url).toBe(
		"https://api.line.me/v2/bot/group/Cgroup0001/member/Uone",
	);
	line.profiles["Rroom0001/Uone"] = { displayName: "In a room" };
	expect(await port.profile("line:room:Rroom0001", "Uone")).toEqual({
		displayName: "In a room",
	});
	expect(calls(line, "/v2/bot/room")).toHaveLength(1);
});

test("a 404 is undefined: the person is not in the chat", async () => {
	const { line, port } = setup();
	expect(
		await port.profile("line:group:Cgroup0001", "Unobody"),
	).toBeUndefined();
	expect(calls(line, "/v2/bot/group")).toHaveLength(1);
});

test("any other status is a LineApiError with the status and an http_ code, and no message holds a body", async () => {
	const base = fakeLine();
	const failing = setup({
		fetch: (async (input: Request | string | URL, init?: RequestInit) => {
			if (String(input).includes("/member/"))
				return new Response("echo: Bearer secret-in-the-body", {
					status: 500,
					headers: { "x-line-request-id": "req-9" },
				});
			return base.fetch(input, init);
		}) as typeof fetch,
	});
	const error = await failing.port
		.profile("line:group:Cgroup0001", "Uone")
		.catch((e: unknown) => e);
	expect(error).toBeInstanceOf(LineApiError);
	expect(error).toMatchObject({
		status: 500,
		code: "http_500",
		requestId: "req-9",
	});
	expect(String((error as Error).message)).not.toContain("secret-in-the-body");
});

test("a profile with no usable name is a LineError, not a nameless profile", async () => {
	const { line, port } = setup();
	line.profiles["Cgroup0001/Uone"] = { displayName: "  " };
	line.profiles["Cgroup0001/Utwo"] = { pictureUrl: "https://x.example.test/p" };
	for (const user of ["Uone", "Utwo"])
		await expect(
			port.profile("line:group:Cgroup0001", user),
		).rejects.toMatchObject({ code: "profile_malformed" });
});

test("a 401 makes the profile call reissue the token and repeat once", async () => {
	const { line, port } = setup();
	line.profiles["Cgroup0001/Uone"] = { displayName: "Ada" };
	await port.profile("line:group:Cgroup0001", "Uone");
	line.revoke("access-token-1");
	expect(await port.profile("line:group:Cgroup0001", "Uone")).toEqual({
		displayName: "Ada",
	});
	expect(line.issued).toEqual(["access-token-1", "access-token-2"]);
});

test("in a one-to-one chat the user's own profile is read, and anyone else's is undefined without a request", async () => {
	const { line, port } = setup();
	line.profiles.Uone = { displayName: "Ada" };
	expect(await port.profile("line:user:Uone", "Uone")).toEqual({
		displayName: "Ada",
	});
	expect(calls(line, "/v2/bot/profile")[0]?.url).toBe(
		"https://api.line.me/v2/bot/profile/Uone",
	);
	const before = line.calls.length;
	expect(await port.profile("line:user:Uone", "Uother")).toBeUndefined();
	expect(line.calls.length).toBe(before);
});

test("a source key or a user id that is not one is refused before any request", async () => {
	const { line, port } = setup();
	await expect(port.profile("not-a-key", "Uone")).rejects.toMatchObject({
		code: "bad_source_key",
	});
	await expect(port.profile("line:group:Cgroup0001", "")).rejects.toMatchObject(
		{ code: "bad_user_id" },
	);
	await expect(
		port.profile("line:group:Cgroup0001", "Uone", { timeoutMs: 0 }),
	).rejects.toMatchObject({ code: "bad_options" });
	expect(line.calls).toHaveLength(0);
});

test("the caller's signal and timeout apply to the call", async () => {
	const { line, port } = setup();
	line.profiles["Cgroup0001/Uone"] = { displayName: "Ada" };
	const controller = new AbortController();
	controller.abort(new Error("gave up"));
	await expect(
		port.profile("line:group:Cgroup0001", "Uone", {
			signal: controller.signal,
		}),
	).rejects.toThrow("gave up");
	await port.profile("line:group:Cgroup0001", "Uone", { timeoutMs: 5_000 });
});

test("a member count is the chat's count, 1 for a one-to-one chat, and shares the quota gate's one-minute reading", async () => {
	const { line, port, advance } = setup();
	expect(await port.memberCount("line:group:Cgroup0001")).toBe(3);
	expect(await port.memberCount("line:group:Cgroup0001")).toBe(3);
	expect(calls(line, "/v2/bot/group")).toHaveLength(1);
	expect(await port.memberCount("line:user:Uone")).toBe(1);
	expect(calls(line, "/v2/bot/")).toHaveLength(1);
	line.members.Cgroup0001 = 4;
	advance(61_000);
	expect(await port.memberCount("line:group:Cgroup0001")).toBe(4);
	await expect(port.memberCount("nope")).rejects.toMatchObject({
		code: "bad_source_key",
	});
});

test("the quota standing is the gate's reading with the host's cap, for a limited plan and for none", async () => {
	const { line, port, advance } = setup({ monthlyCap: 500 });
	line.quota = 1000;
	line.usage = 120;
	expect(await port.quota()).toEqual({ limit: 1000, used: 120, cap: 500 });
	line.usage = 130;
	expect(await port.quota()).toEqual({ limit: 1000, used: 120, cap: 500 });
	expect(calls(line, "/v2/bot/message/quota")).toHaveLength(2);
	advance(61_000);
	expect(await port.quota()).toEqual({ limit: 1000, used: 130, cap: 500 });
	line.quota = null;
	advance(61_000);
	expect(await port.quota()).toEqual({ limit: undefined, used: 130, cap: 500 });
});

test("a plan with no limit and no cap has a standing of nothing used", async () => {
	const { line, port } = setup();
	line.quota = null;
	line.usage = 77;
	expect(await port.quota()).toEqual({
		limit: undefined,
		used: 0,
		cap: undefined,
	});
	// Only the plan was asked: with nothing to compare with, consumption is not read.
	expect(calls(line, "/v2/bot/message/quota/consumption")).toHaveLength(0);
});

test("a quota that cannot be read rejects", async () => {
	const { line, port } = setup();
	line.failQuota(500);
	await expect(port.quota()).rejects.toBeInstanceOf(LineApiError);
});

test("bot info is asked once and kept; a failure is asked again next time", async () => {
	const { line, port } = setup();
	line.botInfo = { basicId: "@not-valid because spaces" };
	await expect(port.botInfo()).rejects.toMatchObject({
		code: "bot_info_malformed",
	});
	line.botInfo = {
		basicId: "@bot-for-tests",
		displayName: "Test Bot",
		pictureUrl: "https://pictures.example.test/bot.png",
	};
	const info = await port.botInfo();
	expect(info).toEqual({
		userId: "Ubot-for-tests",
		basicId: "@bot-for-tests",
		displayName: "Test Bot",
		pictureUrl: "https://pictures.example.test/bot.png",
	});
	const asked = calls(line, "/v2/bot/info").length;
	expect(await port.botInfo()).toEqual(info);
	expect(calls(line, "/v2/bot/info")).toHaveLength(asked);
	// The caller gets a copy: changing it does not change what is kept.
	info.basicId = "@changed";
	expect((await port.botInfo()).basicId).toBe("@bot-for-tests");
});

test("bot info without a name or picture leaves them out", async () => {
	const { line, port } = setup();
	line.botInfo = { basicId: "@bot-for-tests", displayName: "", pictureUrl: 3 };
	expect(await port.botInfo()).toEqual({
		userId: "Ubot-for-tests",
		basicId: "@bot-for-tests",
	});
});

test("a reply is sent with its token and messages, and takes 1 to 5 messages", async () => {
	const { line, port } = setup();
	await port.reply("reply-token-1", [{ type: "text", text: "hello" }], {
		timeoutMs: 3_000,
	});
	expect(line.replies).toEqual([
		{
			replyToken: "reply-token-1",
			messages: [{ type: "text", text: "hello" }],
			status: 200,
		},
	]);
	const message = { type: "text", text: "x" };
	await port.reply("reply-token-2", Array(5).fill(message));
	const before = line.replies.length;
	for (const bad of [[], Array(6).fill(message), [{ text: "no type" }], [null]])
		await expect(
			port.reply("reply-token-3", bad as never),
		).rejects.toMatchObject({ code: "bad_messages" });
	await expect(port.reply("", [message])).rejects.toMatchObject({
		code: "bad_reply_token",
	});
	expect(line.replies).toHaveLength(before);
});

test("a reply LINE refuses is a LineApiError, as for a token already used", async () => {
	const { port } = setup();
	const message = { type: "text", text: "x" };
	await port.reply("reply-token-1", [message]);
	await expect(port.reply("reply-token-1", [message])).rejects.toMatchObject({
		status: 400,
		code: "http_400",
	});
});

test("probeToken is undefined when a token is held or can be issued, else the failure's code, and tells no listener", async () => {
	const { line, port, tokens, advance } = setup();
	const told: string[] = [];
	port.onTokenFailure((code) => told.push(code));
	expect(await port.probeToken()).toBeUndefined();
	expect(line.issued).toEqual(["access-token-1"]);
	// A held token is not asked for again.
	expect(await port.probeToken()).toBeUndefined();
	expect(line.issued).toHaveLength(1);
	advance(900_000);
	line.failTokens(500);
	expect(await port.probeToken()).toBe("token_refused");
	line.failTokens(undefined);
	line.breakNetwork(true);
	expect(await port.probeToken()).toBe("token_unreachable");
	line.breakNetwork(false);
	expect(told).toEqual([]);
	// The failure still shows in the plugin's health.
	expect(tokens.health().lastFailure).toBe("token_unreachable");
	expect(await port.probeToken()).toBeUndefined();
	expect(tokens.health().lastFailure).toBeUndefined();
});

test("a static token is never probed", async () => {
	const line = fakeLine();
	const tokens = new TokenSource({
		credentials: { ...credentials, token: { static: "static-token-value" } },
		fetch: line.fetch,
	});
	const api = new LineApi({ tokens, fetch: line.fetch });
	const port = lineApiPort({
		api,
		tokens,
		quota: new QuotaGate({ api, now: () => new Date() }),
	});
	expect(await port.probeToken()).toBeUndefined();
	expect(line.calls).toHaveLength(0);
});

test("a failed issue is told to every listener once, however many callers shared it, and not after a listener detaches", async () => {
	const { line, port, tokens } = setup();
	const first: string[] = [];
	const second: string[] = [];
	const detachFirst = port.onTokenFailure((code) => first.push(code));
	port.onTokenFailure((code) => second.push(code));
	line.failTokens(500);
	const results = await Promise.allSettled(
		Array.from({ length: 6 }, () => tokens.token()),
	);
	expect(results.every((r) => r.status === "rejected")).toBe(true);
	expect(
		line.calls.filter((c) => c.url.endsWith("/oauth2/v3/token")),
	).toHaveLength(1);
	expect(first).toEqual(["token_refused"]);
	expect(second).toEqual(["token_refused"]);
	// Whichever part of the plugin asked: a call through the API port is such a caller.
	await port.reply("t", [{ type: "text", text: "x" }]).catch(() => undefined);
	expect(first).toEqual(["token_refused", "token_refused"]);
	detachFirst();
	await tokens.token().catch(() => undefined);
	expect(first).toHaveLength(2);
	expect(second).toHaveLength(3);
	line.failTokens(undefined);
	line.breakNetwork(true);
	await tokens.token().catch(() => undefined);
	line.breakNetwork(false);
	expect(second.at(-1)).toBe("token_unreachable");
});

test("a token endpoint that answers without a token is told as token_malformed", async () => {
	const told: string[] = [];
	const { port, tokens } = setup({
		fetch: (async () =>
			Response.json({ nothing: true })) as unknown as typeof fetch,
	});
	port.onTokenFailure((code) => told.push(code));
	await expect(tokens.token()).rejects.toMatchObject({
		code: "token_malformed",
	});
	expect(told).toEqual(["token_malformed"]);
});

test("a probe that a real caller joins is told, and one listener that throws does not stop the others", async () => {
	const line = fakeLine();
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const slow = (async (input: Request | string | URL, init?: RequestInit) => {
		await gate;
		return line.fetch(input, init);
	}) as typeof fetch;
	line.failTokens(500);
	const { port, tokens } = setup({ fetch: slow });
	const told: string[] = [];
	port.onTokenFailure(() => {
		throw new Error("a bad listener");
	});
	port.onTokenFailure((code) => told.push(code));
	const probing = port.probeToken();
	const asking = tokens.token().catch((e: unknown) => e);
	release();
	expect(await probing).toBe("token_refused");
	expect(await asking).toBeInstanceOf(LineError);
	expect(told).toEqual(["token_refused"]);
});
