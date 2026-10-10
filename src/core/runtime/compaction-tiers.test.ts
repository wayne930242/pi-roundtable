import { describe, expect, test } from "bun:test";
import {
	type ExtensionAPI,
	type SessionBeforeCompactEvent,
	SessionManager,
	shouldCompact,
} from "@earendil-works/pi-coding-agent";
import {
	CompactionTiers,
	compactionEngine,
	HARD_COMPACT_TOKENS,
	SOFT_COMPACT_TOKENS,
} from "./compaction-tiers.ts";

const WINDOWS: Record<string, number> = {
	"anthropic/claude-opus-5-5": 1_000_000,
	"anthropic/claude-200k-opus-5-5": 200_000,
};
const LARGE = { provider: "anthropic", id: "claude-opus-5-5" };
const SMALL = { provider: "anthropic", id: "claude-200k-opus-5-5" };
const PI_RESERVE = 16_384;
/** The `engine` a compaction extension records in its compactions' details. */
const EXTENSION_ENGINE = "acme-compaction";

/** pi estimates a message at a token per four characters. */
function text(tokens: number): string {
	return "x".repeat(tokens * 4);
}

function say(session: SessionManager, tokens: number): string {
	return session.appendMessage({
		role: "user",
		content: text(tokens),
		timestamp: Date.now(),
	});
}

/** Appends a compaction that leaves about `left` tokens: its summary and one small kept message. */
function compacted(
	session: SessionManager,
	engine: "extension" | "pi",
	left: number,
): void {
	const kept = say(session, 1_000);
	session.appendCompaction(
		text(left - 1_000),
		kept,
		SOFT_COMPACT_TOKENS,
		engine === "extension" ? { engine: EXTENSION_ENGINE } : {},
	);
}

/** Appends a reply whose request sent `sent` tokens, system prompt and tools included. */
function replied(session: SessionManager, sent: number): void {
	session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5-5",
		usage: {
			input: 1_000,
			output: 500,
			cacheRead: sent - 1_000,
			cacheWrite: 0,
			totalTokens: sent + 500,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

/** A session whose requests carry `fixed` tokens of system prompt and tools, compacted to `left` of messages. */
function compactedWithFixed(fixed: number, left: number): SessionManager {
	const session = SessionManager.inMemory("/tmp");
	say(session, 300_000);
	replied(session, fixed + 300_000);
	compacted(session, "extension", left);
	return session;
}

function tiersOver(session: SessionManager): CompactionTiers {
	return new CompactionTiers(
		session,
		(provider, id) => WINDOWS[`${provider}/${id}`],
		EXTENSION_ENGINE,
	);
}

/** The context size the model compacts past, as pi's own check sees it. */
function trigger(tiers: CompactionTiers, model = LARGE): number {
	const settings = tiers.settings().getCompactionSettings(model);
	const window = WINDOWS[`${model.provider}/${model.id}`] ?? 0;
	const at = window - settings.reserveTokens;
	expect(shouldCompact(at, window, settings)).toBe(false);
	expect(shouldCompact(at + 1, window, settings)).toBe(true);
	return at;
}

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Loads a stand-in for a compaction extension through the tiers' wrapper. */
function loadExtension(
	tiers: CompactionTiers,
	prepare?: (event: SessionBeforeCompactEvent) => void,
) {
	const extensionCalls: number[] = [];
	const bypasses: { reason: string; tokensBefore: number }[] = [];
	const handlers = new Map<string, Handler>();
	const onStart: Handler = () => undefined;
	tiers.wrapCompactor(
		(pi) => {
			pi.on("session_start", onStart as never);
			pi.on("session_before_compact", (event) => {
				extensionCalls.push(event.preparation.tokensBefore);
				return { compaction: { summary: "extension" } } as never;
			});
		},
		(bypass) => bypasses.push(bypass),
		prepare,
	)({
		on: (event: string, handler: Handler) => handlers.set(event, handler),
	} as unknown as ExtensionAPI);
	const compact = (tokensBefore: number) =>
		handlers.get("session_before_compact")?.(
			{ type: "session_before_compact", preparation: { tokensBefore } },
			{},
		);
	return { compact, extensionCalls, bypasses, onStart, handlers };
}

describe("soft threshold", () => {
	test("a 1M model compacts past 300k", () => {
		const tiers = tiersOver(SessionManager.inMemory("/tmp"));
		expect(trigger(tiers)).toBe(SOFT_COMPACT_TOKENS);
	});

	test("a 200k model keeps pi's default reserve", () => {
		const tiers = tiersOver(SessionManager.inMemory("/tmp"));
		expect(tiers.settings().getCompactionSettings(SMALL).reserveTokens).toBe(
			PI_RESERVE,
		);
		expect(trigger(tiers, SMALL)).toBe(200_000 - PI_RESERVE);
	});

	test("an unknown model keeps pi's default reserve", () => {
		const tiers = tiersOver(SessionManager.inMemory("/tmp"));
		expect(
			tiers.settings().getCompactionSettings({ provider: "x", id: "y" })
				.reserveTokens,
		).toBe(PI_RESERVE);
	});
});

describe("hard ceiling", () => {
	test("a compaction above 500k skips the extension, so pi's summary runs", async () => {
		const extension = loadExtension(tiersOver(SessionManager.inMemory("/tmp")));
		expect(await extension.compact(HARD_COMPACT_TOKENS + 1)).toBeUndefined();
		expect(extension.extensionCalls).toEqual([]);
		expect(extension.bypasses).toEqual([
			{
				reason: "above the hard ceiling",
				tokensBefore: HARD_COMPACT_TOKENS + 1,
			},
		]);
	});

	test("a compaction at or below 500k goes to the extension", async () => {
		const extension = loadExtension(tiersOver(SessionManager.inMemory("/tmp")));
		expect(await extension.compact(HARD_COMPACT_TOKENS)).toEqual({
			compaction: { summary: "extension" },
		});
		expect(await extension.compact(SOFT_COMPACT_TOKENS + 1)).toEqual({
			compaction: { summary: "extension" },
		});
		expect(extension.extensionCalls).toEqual([
			HARD_COMPACT_TOKENS,
			SOFT_COMPACT_TOKENS + 1,
		]);
		expect(extension.bypasses).toEqual([]);
	});

	test("after the extension left more than 500k, the next compaction is pi's", async () => {
		const session = SessionManager.inMemory("/tmp");
		say(session, 10_000);
		compacted(session, "extension", 520_000);
		const tiers = tiersOver(session);
		expect(tiers.latest()?.contextTokens).toBeGreaterThan(HARD_COMPACT_TOKENS);
		const extension = loadExtension(tiers);
		expect(await extension.compact(450_000)).toBeUndefined();
		expect(extension.extensionCalls).toEqual([]);
		expect(extension.bypasses[0]?.reason).toContain(
			"The extension's last compaction",
		);
	});

	test("what the extension is given is prepared first, and only when it answers", async () => {
		const prepared: number[] = [];
		const extension = loadExtension(
			tiersOver(SessionManager.inMemory("/tmp")),
			(event) => prepared.push(event.preparation.tokensBefore),
		);
		await extension.compact(200_000);
		await extension.compact(600_000);
		expect(prepared).toEqual([200_000]);
		expect(extension.extensionCalls).toEqual([200_000]);
	});

	test("only session_before_compact is wrapped", () => {
		const extension = loadExtension(tiersOver(SessionManager.inMemory("/tmp")));
		expect(extension.handlers.get("session_start")).toBe(extension.onStart);
	});
});

describe("no compaction loop", () => {
	test("the extension leaving the context near 300k moves the next compaction to 500k", () => {
		const session = SessionManager.inMemory("/tmp");
		say(session, 10_000);
		compacted(session, "extension", 310_000);
		const tiers = tiersOver(session);
		// The same request's next check sees about what the extension left, and does not compact again.
		const settings = tiers.settings().getCompactionSettings(LARGE);
		expect(shouldCompact(311_000, 1_000_000, settings)).toBe(false);
		expect(trigger(tiers)).toBe(HARD_COMPACT_TOKENS);

		session.appendMessage({
			role: "user",
			content: "small",
			timestamp: Date.now(),
		});
		compacted(session, "extension", 280_000);
		expect(trigger(tiers)).toBe(HARD_COMPACT_TOKENS);
	});

	test("a compaction well below 300k keeps the soft threshold", () => {
		const session = SessionManager.inMemory("/tmp");
		say(session, 10_000);
		compacted(session, "extension", 310_000);
		const tiers = tiersOver(session);
		expect(trigger(tiers)).toBe(HARD_COMPACT_TOKENS);
		// pi's summary at the ceiling brings the session back to the soft tier.
		compacted(session, "pi", 30_000);
		expect(trigger(tiers)).toBe(SOFT_COMPACT_TOKENS);
	});

	test("pi's summary leaving the context near 500k falls back to pi's own threshold", () => {
		const session = SessionManager.inMemory("/tmp");
		say(session, 10_000);
		compacted(session, "pi", 480_000);
		expect(trigger(tiersOver(session))).toBe(1_000_000 - PI_RESERVE);
	});

	test("the extension leaving the context near 500k still leaves pi the ceiling", () => {
		const session = SessionManager.inMemory("/tmp");
		say(session, 10_000);
		compacted(session, "extension", 480_000);
		expect(trigger(tiersOver(session))).toBe(HARD_COMPACT_TOKENS);
	});
});

describe("the context a request sends", () => {
	const FIXED = 112_000;

	test("before a request, the context left counts the fixed part the last request carried", () => {
		const tiers = tiersOver(compactedWithFixed(FIXED, 145_000));
		const latest = tiers.latest();
		expect(latest?.measured).toBe(false);
		expect(latest?.contextTokens).toBeGreaterThan(FIXED + 145_000 - 1_000);
		expect(latest?.contextTokens).toBeLessThan(FIXED + 145_000 + 1_000);
		expect(trigger(tiers)).toBe(HARD_COMPACT_TOKENS);
	});

	test("the first request after the compaction measures it", () => {
		const session = compactedWithFixed(FIXED, 145_000);
		const tiers = tiersOver(session);
		expect(trigger(tiers)).toBe(HARD_COMPACT_TOKENS);
		replied(session, 272_000);
		expect(tiers.latest()).toMatchObject({
			contextTokens: 272_000,
			measured: true,
		});
		expect(trigger(tiers)).toBe(HARD_COMPACT_TOKENS);
		// Later requests grow the context; the compaction left what the first one sent.
		replied(session, 400_000);
		expect(tiers.latest()?.contextTokens).toBe(272_000);
	});

	test("a first request well below 300k keeps the soft threshold", () => {
		const session = compactedWithFixed(FIXED, 145_000);
		replied(session, 200_000);
		expect(trigger(tiersOver(session))).toBe(SOFT_COMPACT_TOKENS);
	});

	test("a small fixed part keeps the soft threshold", () => {
		const tiers = tiersOver(compactedWithFixed(5_000, 145_000));
		expect(trigger(tiers)).toBe(SOFT_COMPACT_TOKENS);
	});

	test("a compaction that left 272k real does not compact again until past 500k", () => {
		const session = compactedWithFixed(FIXED, 145_000);
		const tiers = tiersOver(session);
		replied(session, 272_000);
		say(session, 20_000);
		say(session, 20_000);
		const settings = tiers.settings().getCompactionSettings(LARGE);
		expect(shouldCompact(320_000, 1_000_000, settings)).toBe(false);
		expect(shouldCompact(HARD_COMPACT_TOKENS, 1_000_000, settings)).toBe(false);
		expect(shouldCompact(HARD_COMPACT_TOKENS + 1, 1_000_000, settings)).toBe(
			true,
		);
	});
});

describe("compaction engine", () => {
	test("a compaction is the extension's only when it records the engine the plugin declared", () => {
		expect(
			compactionEngine({ engine: EXTENSION_ENGINE }, EXTENSION_ENGINE),
		).toBe("extension");
		expect(compactionEngine({ engine: "other" }, EXTENSION_ENGINE)).toBe("pi");
		expect(compactionEngine({}, EXTENSION_ENGINE)).toBe("pi");
		expect(compactionEngine(undefined, EXTENSION_ENGINE)).toBe("pi");
		expect(compactionEngine({ engine: EXTENSION_ENGINE }, undefined)).toBe(
			"pi",
		);
	});
});
