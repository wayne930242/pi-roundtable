import { expect, test } from "bun:test";
import { needsKey } from "./preflight.ts";

test("the preflight passes with the key and throws without it", () => {
	expect(() =>
		needsKey("API_KEY", { API_KEY: "x" }).preflight?.(),
	).not.toThrow();
	expect(() => needsKey("API_KEY", {}).preflight?.()).toThrow(
		"API_KEY is empty. Set it in .env.",
	);
});
