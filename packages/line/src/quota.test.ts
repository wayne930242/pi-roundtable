import { beforeEach, expect, test } from "bun:test";
import { LineApi } from "./api.ts";
import { QuotaGate } from "./quota.ts";
import { CHANNEL_ID, fakeLine, SECRET } from "./testing/line-fake.ts";
import { TokenSource } from "./token.ts";

let clock = 0;
const now = () => new Date(1_700_000_000_000 + clock);

function gate(monthlyCap?: number) {
	const fake = fakeLine();
	const api = new LineApi({
		tokens: new TokenSource({
			credentials: { channelId: CHANNEL_ID, channelSecret: SECRET },
			fetch: fake.fetch,
		}),
		fetch: fake.fetch,
	});
	const quota = new QuotaGate({
		api,
		now,
		...(monthlyCap === undefined ? {} : { options: { monthlyCap } }),
	});
	const reads = () =>
		fake.calls.filter((c) => c.url.endsWith("/message/quota/consumption"))
			.length;
	return { fake, quota, reads };
}

beforeEach(() => {
	clock = 0;
});

test("a push is let through while consumption, reservations and its recipients fit the quota", async () => {
	const { fake, quota } = gate();
	fake.quota = 10;
	fake.usage = 4;
	const first = await quota.reserve(3);
	expect(first.ok).toBe(true);
	// 4 used + 3 reserved + 3 = 10: exactly the quota still fits.
	const second = await quota.reserve(3);
	expect(second.ok).toBe(true);
	expect(quota.reserved()).toBe(6);
	// One more recipient is over it.
	const third = await quota.reserve(1);
	expect(third).toMatchObject({
		ok: false,
		used: 4,
		reserved: 6,
		recipients: 1,
		cap: 10,
	});
});

test("the gate keeps to the lower of the plan's quota and the host's monthly cap", async () => {
	const lowCap = gate(5);
	lowCap.fake.quota = 1000;
	lowCap.fake.usage = 3;
	expect((await lowCap.quota.reserve(2)).ok).toBe(true);
	expect(await lowCap.quota.reserve(1)).toMatchObject({ ok: false, cap: 5 });

	const lowQuota = gate(1000);
	lowQuota.fake.quota = 5;
	lowQuota.fake.usage = 5;
	expect(await lowQuota.quota.reserve(1)).toMatchObject({ ok: false, cap: 5 });

	// A plan without a limit is held to the cap alone; with neither nothing is compared.
	const unlimited = gate(4);
	unlimited.fake.quota = null;
	unlimited.fake.usage = 4;
	expect(await unlimited.quota.reserve(1)).toMatchObject({ ok: false, cap: 4 });
	const open = gate();
	open.fake.quota = null;
	open.fake.usage = 9_999_999;
	expect((await open.quota.reserve(100)).ok).toBe(true);
	expect(open.reads()).toBe(0);
});

test("readings are cached for a minute and read again after", async () => {
	const { fake, quota, reads } = gate();
	fake.quota = 100;
	await quota.reserve(1);
	await quota.reserve(1);
	expect(reads()).toBe(1);
	clock = 59_000;
	await quota.reserve(1);
	expect(reads()).toBe(1);
	clock = 61_000;
	await quota.reserve(1);
	expect(reads()).toBe(2);
});

test("concurrent reservations share one reading and cannot all squeeze through", async () => {
	const { fake, quota, reads } = gate();
	fake.quota = 5;
	const results = await Promise.all(
		Array.from({ length: 8 }, () => quota.reserve(1)),
	);
	expect(results.filter((r) => r.ok)).toHaveLength(5);
	expect(reads()).toBe(1);
});

test("a reservation of a push that went out stays counted until a reading after it, a failed one is dropped at once", async () => {
	const { fake, quota } = gate();
	fake.quota = 4;
	const sent = await quota.reserve(2);
	const failed = await quota.reserve(2);
	if (!sent.ok || !failed.ok) throw new Error("expected both to fit");
	quota.settle(failed.reservation, false);
	expect(quota.reserved()).toBe(2);
	quota.settle(sent.reservation, true);
	// LINE has not counted it yet (the cached reading is old): the gate still does.
	expect(quota.reserved()).toBe(2);
	const held = await quota.reserve(2);
	if (!held.ok) throw new Error("expected it to fit");
	expect((await quota.reserve(1)).ok).toBe(false);
	quota.settle(held.reservation, false);
	// A reading begun after the push now includes it, so it is no longer counted twice.
	fake.usage = 2;
	clock = 61_000;
	const after = await quota.reserve(2);
	expect(after.ok).toBe(true);
	// 2 used + the new 2 = the quota of 4: the sent push is counted once, by LINE.
	expect(quota.reserved()).toBe(2);
});

test("a group's recipients are its member count, a user's is one, and a count is cached for a minute", async () => {
	const { fake, quota } = gate();
	fake.members.Cgroup0001 = 7;
	expect(await quota.recipients("line:group:Cgroup0001")).toBe(7);
	expect(await quota.recipients("line:user:Uuser0001")).toBe(1);
	fake.members.Cgroup0001 = 9;
	expect(await quota.recipients("line:group:Cgroup0001")).toBe(7);
	clock = 61_000;
	expect(await quota.recipients("line:group:Cgroup0001")).toBe(9);
	fake.members.Croom = 0;
	expect(await quota.recipients("line:room:Croom")).toBe(1);
	await expect(quota.recipients("line:group:Cunknown")).rejects.toMatchObject({
		code: "http_404",
	});
	await expect(quota.recipients("nope")).rejects.toMatchObject({
		code: "bad_source_key",
	});
});

test("a quota that cannot be read rejects instead of letting a push through", async () => {
	const { fake, quota } = gate();
	fake.failQuota(500);
	await expect(quota.reserve(1)).rejects.toMatchObject({ code: "http_500" });
	fake.failQuota(undefined);
	expect((await quota.reserve(1)).ok).toBe(true);
});
