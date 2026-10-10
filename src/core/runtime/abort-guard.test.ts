import { describe, expect, test } from "bun:test";
import { AbortGuard } from "./abort-guard.ts";

function session() {
	const calls: string[] = [];
	return {
		calls,
		abort: async () => void calls.push("abort"),
		dispose: () => void calls.push("dispose"),
	};
}

describe("AbortGuard", () => {
	test("aborts the run, and disposes of the session and gives up when the run outlives the grace", async () => {
		const s = session();
		const gaveUp: string[] = [];
		const guard = new AbortGuard(s, {
			graceMs: 10,
			onGiveUp: () => void gaveUp.push("given up"),
		});
		guard.abort();
		guard.abort();
		await expect(guard.gaveUp).rejects.toThrow("did not stop");
		expect(s.calls).toEqual(["abort", "abort", "dispose"]);
		expect(gaveUp).toEqual(["given up"]);
	});

	test("leaves the session alone once the run ended within the grace", async () => {
		const s = session();
		const guard = new AbortGuard(s, { graceMs: 10 });
		guard.abort();
		guard.release();
		await Bun.sleep(30);
		expect(s.calls).toEqual(["abort"]);
	});

	test("gives up even when the session cannot be disposed of", async () => {
		const guard = new AbortGuard(
			{
				abort: async () => undefined,
				dispose: () => {
					throw new Error("already gone");
				},
			},
			{ graceMs: 5 },
		);
		guard.abort();
		await expect(guard.gaveUp).rejects.toThrow();
	});
});
