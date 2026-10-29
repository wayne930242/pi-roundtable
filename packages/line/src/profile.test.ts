import { expect, test } from "bun:test";
import type { LineApiPort } from "./api-port.ts";
import { lineProfileSource } from "./profile.ts";

const USER = "U0123456789abcdef0123456789abcdef";

function api(profile: LineApiPort["profile"]): Pick<LineApiPort, "profile"> {
	return { profile };
}

test("the source reads a person's own LINE profile by their user id, with the caller's signal", async () => {
	const calls: unknown[][] = [];
	const source = lineProfileSource(
		api(async (...args) => {
			calls.push(args);
			return {
				displayName: "Ada",
				pictureUrl: "https://profile.line-scdn.net/abc",
			};
		}),
	);
	const signal = new AbortController().signal;
	expect(await source.fetch(USER, signal)).toEqual({
		name: "Ada",
		pictureUrl: "https://profile.line-scdn.net/abc",
	});
	expect(calls).toEqual([[`line:user:${USER}`, USER, { signal }]]);
});

test("a person without a picture, or not found, gives what LINE gave", async () => {
	const signal = new AbortController().signal;
	expect(
		await lineProfileSource(api(async () => ({ displayName: "Bo" }))).fetch(
			USER,
			signal,
		),
	).toEqual({ name: "Bo" });
	expect(
		await lineProfileSource(api(async () => undefined)).fetch(USER, signal),
	).toBeUndefined();
});

test("the source names LINE, its picture hosts, and is not model-visible on its own", () => {
	const source = lineProfileSource(api(async () => undefined));
	expect(source).toMatchObject({
		provider: "line",
		label: "LINE",
		modelVisible: false,
		pictureHosts: ["profile.line-scdn.net", "obs.line-scdn.net"],
	});
});

test("an error of LINE reaches the caller, which treats it as a miss", async () => {
	const source = lineProfileSource(
		api(async () => {
			throw new Error("http_500");
		}),
	);
	expect(source.fetch(USER, new AbortController().signal)).rejects.toThrow(
		"http_500",
	);
});
