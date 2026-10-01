import { describe, expect, test } from "bun:test";
import { AgentRunError } from "../domain/errors.ts";
import { settleTurn } from "./settle-turn.ts";

describe("settleTurn", () => {
	test("passes a finished turn's result through", async () => {
		expect(await settleTurn(async () => ({ ok: true }), "turn")).toEqual({
			ok: true,
		});
	});

	test("turns a thrown error into a failed result naming what crashed", async () => {
		const result = await settleTurn(async () => {
			throw new Error("socket closed");
		}, "role turn");
		expect(result).toEqual({
			ok: false,
			error: new AgentRunError("role turn crashed: Error: socket closed"),
		});
	});
});
