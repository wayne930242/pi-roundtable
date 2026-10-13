import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "../log.ts";
import { CardCopies } from "./card-copies.ts";

const DAY = 24 * 60 * 60_000;
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function ledger(entries: Record<string, { text: string; at: number }>) {
	const dir = mkdtempSync(join(tmpdir(), "card-copies-prune-"));
	dirs.push(dir);
	const path = join(dir, "card-copies.json");
	writeFileSync(path, `${JSON.stringify(entries)}\n`);
	return path;
}

const stored = (path: string) =>
	Object.keys(JSON.parse(readFileSync(path, "utf8")) as object);

describe("expired card copy texts leave the file", () => {
	test("after a load (a restart), without any new remember", async () => {
		const path = ledger({
			old: { text: "a", at: 0 },
			fresh: { text: "b", at: 40 * DAY },
		});
		const copies = new CardCopies({
			path,
			logger: silentLogger(),
			now: () => 45 * DAY,
		});
		await copies.flush();
		expect(stored(path)).toEqual(["fresh"]);
	});

	test("after a recall that finds an entry past keepDays", async () => {
		let now = 1 * DAY;
		const path = ledger({ a: { text: "a", at: 0 } });
		const copies = new CardCopies({
			path,
			keepDays: 30,
			logger: silentLogger(),
			now: () => now,
		});
		await copies.flush();
		expect(stored(path)).toEqual(["a"]);
		now = 31 * DAY;
		expect(copies.recall("a")).toBeUndefined();
		await copies.flush();
		expect(stored(path)).toEqual([]);
	});

	test("on the timer, with a fake clock and timer, and stop clears it", async () => {
		let now = 1 * DAY;
		const path = ledger({ a: { text: "a", at: 0 } });
		let tick: (() => void) | undefined;
		let interval: number | undefined;
		let cleared = false;
		const realClear = globalThis.clearInterval;
		globalThis.clearInterval = (() => {
			cleared = true;
		}) as typeof clearInterval;
		try {
			const copies = new CardCopies({
				path,
				keepDays: 30,
				logger: silentLogger(),
				now: () => now,
				sweepMs: 1234,
				setInterval: ((fn: () => void, ms: number) => {
					tick = fn;
					interval = ms;
					return { unref() {} };
				}) as unknown as typeof setInterval,
			});
			copies.start();
			expect(interval).toBe(1234);
			now = 31 * DAY;
			tick?.();
			await copies.flush();
			expect(stored(path)).toEqual([]);
			await copies.stop();
			expect(cleared).toBe(true);
		} finally {
			globalThis.clearInterval = realClear;
		}
	});

	test("nothing is written when nothing expired", async () => {
		const path = ledger({ a: { text: "a", at: 0 } });
		const before = readFileSync(path, "utf8");
		const copies = new CardCopies({
			path,
			logger: silentLogger(),
			now: () => 1 * DAY,
		});
		await copies.flush();
		expect(readFileSync(path, "utf8")).toBe(before);
	});
});
