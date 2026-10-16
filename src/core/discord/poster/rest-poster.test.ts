import { expect, test } from "bun:test";
import { inspect } from "node:util";
import { DiscordAPIError, HTTPError } from "discord.js";
import { restSubject } from "./poster-contract-rest.ts";
import { freshId } from "./poster-contract-support.ts";
import type { DiscordFailure } from "./poster-errors.ts";
import { DiscordPosterError } from "./poster-errors.ts";
import { type DiscordRest, restPoster } from "./rest-poster.ts";
import { canViewChannel } from "./rest-poster-guild.ts";

const CHANNEL = "900000000000000101";
const MESSAGE = "900000000000000102";
const USER = "900000000000000103";
const BOT = "900000000000000104";
const HOOK = "900000000000000105";
const TOKEN = "webhook-token-secret-value";

function apiError(
	code: number,
	status: number,
	extra?: Record<string, unknown>,
) {
	return new DiscordAPIError(
		{ code, message: "said so", ...extra },
		code,
		status,
		"POST",
		`https://discord.test/api/v10/webhooks/${HOOK}/${TOKEN}`,
		{},
	);
}

interface Call {
	method: string;
	route: string;
}

/** A Discord that answers by route, or throws what `fail` returns; every call is recorded. */
function mockRest(
	fail: (call: Call) => unknown,
): DiscordRest & { calls: Call[] } {
	const calls: Call[] = [];
	const make = (method: string) => async (route: string) => {
		const call = { method, route };
		calls.push(call);
		const thrown = fail(call);
		if (thrown instanceof Error) throw thrown;
		if (thrown !== undefined) return thrown;
		if (route === "/users/@me") return { id: BOT };
		if (route === `/channels/${CHANNEL}/webhooks`)
			return method === "GET"
				? [{ id: HOOK, token: TOKEN, name: "relay", user: { id: BOT } }]
				: { id: HOOK, token: TOKEN };
		return { id: MESSAGE };
	};
	return {
		calls,
		get: make("GET"),
		post: make("POST"),
		patch: make("PATCH"),
		put: make("PUT"),
		delete: make("DELETE"),
	};
}

const MAPPING: [string, number, number, DiscordFailure][] = [
	["unknown channel", 10003, 404, "channel_gone"],
	["unknown message", 10008, 404, "message_gone"],
	["missing permissions", 50013, 403, "forbidden"],
	["missing access", 50001, 403, "forbidden"],
	["cannot edit a system message", 50021, 403, "rejected"],
	["another 4xx", 40000, 400, "rejected"],
	["a 5xx", 0, 503, "unavailable"],
];

for (const [name, code, status, kind] of MAPPING) {
	test(`Discord's ${name} (${status}, code ${code}) is ${kind}`, async () => {
		const rest = mockRest((call) =>
			call.method === "PUT" ? apiError(code, status) : undefined,
		);
		const error = await restPoster(rest)
			.pin(CHANNEL, MESSAGE)
			.then(
				() => undefined,
				(thrown: unknown) => thrown,
			);
		expect(error).toBeInstanceOf(DiscordPosterError);
		expect((error as DiscordPosterError).kind).toBe(kind);
		expect((error as DiscordPosterError).discordCode).toBe(code);
		expect((error as DiscordPosterError).retryable).toBe(
			kind === "unavailable",
		);
	});
}

test("a full category is a form-body error naming the parent: rejected, with its reason", async () => {
	const rest = mockRest((call) =>
		call.method === "POST" && call.route.endsWith("/channels")
			? apiError(50035, 400, {
					errors: {
						parent_id: { _errors: [{ code: "CHANNEL_PARENT_MAX_CHANNELS" }] },
					},
				})
			: call.route === `/channels/${CHANNEL}`
				? { id: CHANNEL, type: 4, guild_id: "900000000000000106" }
				: undefined,
	);
	const error = await restPoster(rest)
		.createTextChannel(CHANNEL, "x")
		.then(
			() => undefined,
			(thrown: unknown) => thrown,
		);
	expect((error as DiscordPosterError).kind).toBe("rejected");
	expect((error as DiscordPosterError).reason).toBe("category_full");
});

test("a network failure and an HTTP failure are unavailable and carry no request", async () => {
	for (const thrown of [
		new TypeError("fetch failed"),
		new HTTPError(
			502,
			"Bad Gateway",
			"POST",
			`https://discord.test/${HOOK}/${TOKEN}`,
			{},
		),
	]) {
		const error = await restPoster(
			mockRest((call) => (call.method === "PUT" ? thrown : undefined)),
		)
			.pin(CHANNEL, MESSAGE)
			.then(
				() => undefined,
				(e: unknown) => e,
			);
		expect((error as DiscordPosterError).kind).toBe("unavailable");
		expect((error as DiscordPosterError).message).not.toContain(TOKEN);
		expect((error as DiscordPosterError).message).not.toContain("discord.test");
	}
});

test("a webhook deleted meanwhile (10015, then 50027) is looked for once more; a second refusal is reported", async () => {
	let sends = 0;
	const rest = mockRest((call) => {
		if (call.route.startsWith(`/webhooks/${HOOK}/`)) {
			sends += 1;
			return apiError(sends === 1 ? 10015 : 50027, sends === 1 ? 404 : 401);
		}
		return undefined;
	});
	const error = await restPoster(rest)
		.post(CHANNEL, { webhook: "relay", username: "A", content: "x" })
		.then(
			() => undefined,
			(e: unknown) => e,
		);
	expect(sends).toBe(2);
	expect((error as DiscordPosterError).kind).toBe("rejected");
	expect((error as DiscordPosterError).message).not.toContain(TOKEN);
	expect(
		rest.calls.filter(
			(c) => c.route === `/channels/${CHANNEL}/webhooks` && c.method === "GET",
		),
	).toHaveLength(2);
});

test("a person who takes no direct messages (50007) is an answer; a stranger to the guild (10007) is false and undefined", async () => {
	const closed = mockRest((call) =>
		call.method === "POST" && call.route.startsWith("/channels/")
			? apiError(50007, 403)
			: call.route === "/users/@me/channels"
				? { id: CHANNEL }
				: undefined,
	);
	expect(await restPoster(closed).sendDirect(USER, "hi")).toBe("closed");
	const stranger = mockRest((call) =>
		call.route.includes("/members/")
			? apiError(10007, 404)
			: call.route === `/channels/${CHANNEL}`
				? { id: CHANNEL, guild_id: "900000000000000106" }
				: undefined,
	);
	const poster = restPoster(stranger);
	expect(await poster.canView(CHANNEL, USER)).toBe(false);
	expect(await poster.memberName("900000000000000106", USER)).toBeUndefined();
});

test("the poster shows no token when printed or serialized", async () => {
	const rest = mockRest(() => undefined);
	const poster = restPoster(rest);
	await poster.post(CHANNEL, { webhook: "relay", username: "A", content: "x" });
	expect(inspect(poster, { depth: 6 })).not.toContain(TOKEN);
	expect(JSON.stringify(poster)).not.toContain(TOKEN);
});

test("canViewChannel follows Discord's rule: owner, administrator, @everyone, role and member overwrites", () => {
	const GUILD = "900000000000000200";
	const base = {
		guildId: GUILD,
		userId: USER,
		ownerId: undefined,
		memberRoles: ["900000000000000201"],
		roles: [
			{ id: GUILD, permissions: String(1n << 10n) },
			{ id: "900000000000000201", permissions: "0" },
		],
	};
	expect(canViewChannel({ ...base, overwrites: [] })).toBe(true);
	expect(
		canViewChannel({
			...base,
			ownerId: USER,
			overwrites: [{ id: GUILD, type: 0, deny: String(1n << 10n) }],
		}),
	).toBe(true);
	const denied = [{ id: GUILD, type: 0, allow: "0", deny: String(1n << 10n) }];
	expect(canViewChannel({ ...base, overwrites: denied })).toBe(false);
	expect(
		canViewChannel({
			...base,
			overwrites: [
				...denied,
				{
					id: "900000000000000201",
					type: 0,
					allow: String(1n << 10n),
					deny: "0",
				},
			],
		}),
	).toBe(true);
	expect(
		canViewChannel({
			...base,
			overwrites: [
				...denied,
				{ id: USER, type: 1, allow: String(1n << 10n), deny: "0" },
			],
		}),
	).toBe(true);
	expect(
		canViewChannel({
			...base,
			overwrites: [{ id: USER, type: 1, allow: "0", deny: String(1n << 10n) }],
		}),
	).toBe(false);
	const admin = {
		...base,
		roles: [
			...base.roles,
			{ id: "900000000000000202", permissions: String(1n << 3n) },
		],
		memberRoles: ["900000000000000202"],
	};
	expect(canViewChannel({ ...admin, overwrites: denied })).toBe(true);
});

// Over the emulated Discord: what only HTTP can show.

test("a webhook's own address carries no bot token, and no error holds a token or an address", async () => {
	const { poster, emulator, close } = restSubject();
	try {
		const ch = freshId();
		emulator.addChannel(ch, "900000000000000001");
		const posted = await poster.post(ch, {
			webhook: "relay",
			username: "A",
			content: "x",
		});
		await poster.edit(ch, posted.messageId, { content: "y" }, ["relay"]);
		await poster.remove(ch, posted.messageId, ["relay"]);
		const errors: DiscordPosterError[] = [];
		for (const attempt of [
			() => poster.edit(ch, posted.messageId, { content: "z" }, ["relay"]),
			() => poster.pin(ch, "900000000000099999"),
			() => poster.createTextChannel("900000000000099999", "x"),
		])
			errors.push(
				await attempt().then(
					() => new DiscordPosterError("invalid", "no failure"),
					(e: unknown) => e as DiscordPosterError,
				),
			);
		for (const error of errors) {
			expect(error.message).not.toContain("emulated-webhook-token");
			expect(error.message).not.toContain("test-bot-token");
			expect(error.message).not.toContain("/webhooks/");
			expect(error.message).not.toContain("127.0.0.1");
		}
		const webhookRequests = emulator.log.filter((r) =>
			r.path.startsWith("/webhooks/"),
		);
		expect(webhookRequests.length).toBeGreaterThanOrEqual(3);
		expect(webhookRequests.every((r) => r.authorization === null)).toBe(true);
		const botRequests = emulator.log.filter(
			(r) => !r.path.startsWith("/webhooks/"),
		);
		expect(
			botRequests.every((r) => r.authorization === "Bot test-bot-token"),
		).toBe(true);
		expect(inspect(poster, { depth: 6 })).not.toContain(
			"emulated-webhook-token",
		);
	} finally {
		close();
	}
});

test("a server error is unavailable, and so is a Discord that cannot be reached", async () => {
	const { poster, emulator, close } = restSubject();
	try {
		const ch = freshId();
		emulator.addChannel(ch, "900000000000000001");
		emulator.failNext(4);
		const failed = await poster.say(ch, { content: "x" }).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect((failed as DiscordPosterError).kind).toBe("unavailable");
		await poster.say(ch, { content: "x" });
		emulator.stop();
		const gone = await poster.say(ch, { content: "x" }).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect((gone as DiscordPosterError).kind).toBe("unavailable");
		expect((gone as DiscordPosterError).message).not.toContain("127.0.0.1");
	} finally {
		close();
	}
});

test("a rename Discord holds back is never sent later", async () => {
	const { poster, emulator, close } = restSubject({ renameRetryAfter: 1 });
	try {
		const ch = freshId();
		emulator.addChannel(ch, "900000000000000001");
		await poster.renameChannel(ch, "one");
		await poster.renameChannel(ch, "two");
		const held = await poster.renameChannel(ch, "three").then(
			() => undefined,
			(e: unknown) => e,
		);
		expect((held as DiscordPosterError).kind).toBe("unavailable");
		const patches = () =>
			emulator.log.filter(
				(r) => r.method === "PATCH" && r.path === `/channels/${ch}`,
			).length;
		expect(patches()).toBe(3);
		// Past the wait Discord named, the held request would go out again; the abort keeps it.
		await Bun.sleep(1_600);
		expect(patches()).toBe(3);
		expect(emulator.state.channels.get(ch)?.name).toBe("two");
	} finally {
		close();
	}
});
