import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { silentLogger } from "../log.ts";
import { PersonDirectory } from "./person-profiles.ts";
import { PRINCIPAL_PROFILE_CHOICES } from "./principal-tables.ts";
import { cleanName } from "./profile-memory.ts";
import { fetchPicture, PICTURE_MAX_BYTES } from "./profile-picture.ts";
import type { ProfileRules, ProfileSource } from "./profiles.ts";

const PERSON = "p_01";
const HOUR = 60 * 60_000;
const MINUTE = 60_000;
const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2,
]);

/** The choices table answers "none", so the directory needs no database. */
const noChoices = (() => Promise.resolve([])) as unknown as SQL;

interface Rig {
	directory: PersonDirectory;
	clock: { now: number };
	fetches: string[];
}

function rig(
	rules: Partial<ProfileRules> = {},
	options: {
		linked?: readonly { provider: string; subject: string }[];
		fetchBudgetMs?: number;
		fetch?: (input: string, init?: RequestInit) => Promise<Response>;
	} = {},
): Rig {
	const clock = { now: Date.parse("2026-10-29T09:00:00Z") };
	const fetches: string[] = [];
	const directory = new PersonDirectory({
		sql: noChoices,
		links: {
			identities: async () =>
				options.linked ?? [{ provider: "line", subject: "U1" }],
			displayName: async () => "Display Ada",
		},
		rules: { prefer: ["line"], modelVisible: [], ...rules },
		logger: silentLogger(),
		now: () => clock.now,
		...(options.fetchBudgetMs ? { fetchBudgetMs: options.fetchBudgetMs } : {}),
		fetch:
			options.fetch ??
			(async (input) => {
				fetches.push(input);
				return new Response(PNG, { headers: { "content-type": "image/png" } });
			}),
	});
	return { directory, clock, fetches };
}

function source(
	fetch: ProfileSource["fetch"],
	over: Partial<ProfileSource> = {},
): ProfileSource {
	return {
		provider: "line",
		label: "LINE",
		modelVisible: true,
		pictureHosts: ["profile.line-scdn.net"],
		fetch,
		...over,
	};
}

test("a person with a registered source is shown by its name and picture; one without is shown by the display name", async () => {
	const { directory } = rig();
	expect(await directory.of(PERSON)).toEqual({
		name: "Display Ada",
		picture: false,
	});
	directory.register(
		source(async () => ({
			name: "Line Ada",
			pictureUrl: "https://profile.line-scdn.net/a.png",
		})),
	);
	expect(await directory.of(PERSON)).toEqual({
		name: "Line Ada",
		source: "line",
		picture: true,
	});
	expect(directory.sources()).toEqual([{ provider: "line", label: "LINE" }]);
});

test("a second source for one provider throws", () => {
	const { directory } = rig();
	directory.register(source(async () => undefined));
	expect(() => directory.register(source(async () => undefined))).toThrow(
		"a profile source for line is already registered",
	);
});

test("a fetch that never answers falls back within two seconds and is not asked again for ten minutes", async () => {
	const { directory, clock } = rig();
	let asked = 0;
	directory.register(
		source(() => {
			asked += 1;
			// Only the first ask never answers.
			return asked === 1
				? new Promise(() => undefined)
				: Promise.resolve(undefined);
		}),
	);
	const started = performance.now();
	expect((await directory.of(PERSON)).name).toBe("Display Ada");
	expect(performance.now() - started).toBeLessThan(2_500);
	expect(asked).toBe(1);
	clock.now += 9 * MINUTE;
	expect((await directory.of(PERSON)).name).toBe("Display Ada");
	expect(asked).toBe(1);
	clock.now += 2 * MINUTE;
	await directory.of(PERSON);
	expect(asked).toBe(2);
});

test("a failure and an empty answer are remembered ten minutes like a timeout, and the signal is aborted after a fetch", async () => {
	const { directory, clock } = rig({}, { fetchBudgetMs: 50 });
	let asked = 0;
	let signal: AbortSignal | undefined;
	directory.register(
		source(async (_subject, given) => {
			asked += 1;
			signal = given;
			throw new Error("http_500");
		}),
	);
	await directory.of(PERSON);
	await directory.of(PERSON);
	expect(asked).toBe(1);
	expect(signal?.aborted).toBe(true);
	clock.now += 11 * MINUTE;
	await directory.of(PERSON);
	expect(asked).toBe(2);
});

test("a found profile is reused for an hour, and concurrent asks share one fetch", async () => {
	const { directory, clock } = rig();
	let asked = 0;
	directory.register(
		source(async () => {
			asked += 1;
			return { name: "Line Ada" };
		}),
	);
	await Promise.all([directory.of(PERSON), directory.of(PERSON)]);
	expect(asked).toBe(1);
	clock.now += 59 * MINUTE;
	await directory.of(PERSON);
	expect(asked).toBe(1);
	clock.now += 2 * MINUTE;
	await directory.of(PERSON);
	expect(asked).toBe(2);
});

test("an observed name names the person for an hour and each sign-in renews it", async () => {
	const { directory, clock } = rig(
		{ prefer: ["idp"] },
		{
			linked: [{ provider: "idp", subject: "s1" }],
		},
	);
	expect((await directory.of(PERSON)).name).toBe("Display Ada");
	directory.observed(PERSON, "idp", "Kai  Tester");
	expect(await directory.of(PERSON)).toEqual({
		name: "Kai Tester",
		source: "idp",
		picture: false,
	});
	clock.now += 59 * MINUTE;
	directory.observed(PERSON, "idp", "Kai Tester");
	clock.now += 59 * MINUTE;
	expect((await directory.of(PERSON)).name).toBe("Kai Tester");
	clock.now += 2 * MINUTE;
	expect((await directory.of(PERSON)).name).toBe("Display Ada");
});

test("modelName is the source's name only for a provider the host lists, whatever the source's own flag says", async () => {
	for (const [listed, flag, expected] of [
		[[], true, undefined],
		[["other"], true, undefined],
		[["line"], false, "Line Ada"],
		[["line"], true, "Line Ada"],
	] as const) {
		const { directory } = rig({ modelVisible: listed });
		directory.register(
			source(async () => ({ name: "Line Ada" }), { modelVisible: flag }),
		);
		expect(await directory.modelName(PERSON)).toBe(expected);
	}
});

test("a name is made safe to show and to give an agent: controls go, space collapses, at most 80 characters", () => {
	expect(cleanName("  Ada\u0000\n\u202e Lovelace   ")).toBe("Ada Lovelace");
	expect(cleanName("\u200b \t")).toBeUndefined();
	expect(cleanName(42)).toBeUndefined();
	expect([...(cleanName("x".repeat(200)) ?? "")].length).toBe(80);
});

const PICTURE_URL = "https://profile.line-scdn.net/a.png";
const png = (init?: ResponseInit) =>
	new Response(PNG, {
		headers: { "content-type": "image/png" },
		...init,
	});

test("the picture proxy returns a PNG, JPEG, GIF or WebP from an allowed https host as nosniff and privately cacheable", async () => {
	const { directory, fetches } = rig();
	directory.register(
		source(async () => ({ name: "Ada", pictureUrl: PICTURE_URL })),
	);
	const response = await directory.picture(PERSON);
	expect(response?.headers.get("content-type")).toBe("image/png");
	expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
	expect(response?.headers.get("cache-control")).toBe("private, max-age=3600");
	expect(
		new Uint8Array((await response?.arrayBuffer()) ?? new ArrayBuffer(0)),
	).toEqual(PNG);
	// Kept in memory: a second ask does not fetch again.
	await directory.picture(PERSON);
	expect(fetches).toEqual([PICTURE_URL]);
	const jpeg = await fetchPicture(
		PICTURE_URL,
		["profile.line-scdn.net"],
		async () =>
			new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
				headers: { "content-type": "image/jpeg" },
			}),
	);
	expect(jpeg?.type).toBe("image/jpeg");
});

test("the proxy refuses a host outside the source's, http, credentials, a port, and fetches nothing", async () => {
	let fetched = 0;
	const counting = async () => {
		fetched += 1;
		return png();
	};
	for (const address of [
		"https://evil.example.com/a.png",
		"http://profile.line-scdn.net/a.png",
		"https://user:pw@profile.line-scdn.net/a.png",
		"https://profile.line-scdn.net:8443/a.png",
		"https://profile.line-scdn.net.evil.example.com/a.png",
		"not a url",
	])
		expect(
			await fetchPicture(address, ["profile.line-scdn.net"], counting),
		).toBeUndefined();
	expect(fetched).toBe(0);
});

test("the proxy refuses a redirect, an error status, an SVG, a mislabeled body, and a body over 2 MiB", async () => {
	const hosts = ["profile.line-scdn.net"];
	const ask = (response: Response) =>
		fetchPicture(PICTURE_URL, hosts, async () => response);
	expect(
		await ask(
			new Response(null, {
				status: 302,
				headers: { location: "https://evil.example.com/a.png" },
			}),
		),
	).toBeUndefined();
	expect(await ask(png({ status: 404 }))).toBeUndefined();
	expect(
		await ask(
			new Response("<svg xmlns='http://www.w3.org/2000/svg'/>", {
				headers: { "content-type": "image/svg+xml" },
			}),
		),
	).toBeUndefined();
	// A PNG header over a body that is not one.
	expect(
		await ask(
			new Response("<svg/>", { headers: { "content-type": "image/png" } }),
		),
	).toBeUndefined();
	// A body that is a PNG but declared as another type.
	expect(
		await ask(png({ headers: { "content-type": "image/gif" } })),
	).toBeUndefined();
	const big = new Uint8Array(PICTURE_MAX_BYTES + 1);
	big.set(PNG);
	expect(
		await ask(new Response(big, { headers: { "content-type": "image/png" } })),
	).toBeUndefined();
	// No content-length to go by: the body is cut off at the cap.
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(new Uint8Array(1024 * 1024).fill(1));
		},
	});
	expect(
		await ask(
			new Response(stream, { headers: { "content-type": "image/png" } }),
		),
	).toBeUndefined();
	// Exactly the cap is accepted.
	const exact = new Uint8Array(PICTURE_MAX_BYTES);
	exact.set(PNG);
	expect(
		(
			await ask(
				new Response(exact, { headers: { "content-type": "image/png" } }),
			)
		)?.bytes.byteLength,
	).toBe(PICTURE_MAX_BYTES);
});

test("a picture that fails is not asked for again for ten minutes, and no picture means no response", async () => {
	let asked = 0;
	const { directory, clock } = rig(
		{},
		{
			fetch: async () => {
				asked += 1;
				return png({ status: 500 });
			},
		},
	);
	directory.register(
		source(async () => ({ name: "Ada", pictureUrl: PICTURE_URL })),
	);
	expect(await directory.picture(PERSON)).toBeUndefined();
	expect(await directory.picture(PERSON)).toBeUndefined();
	expect(asked).toBe(1);
	clock.now += 11 * MINUTE;
	await directory.picture(PERSON);
	expect(asked).toBe(2);
	const bare = rig();
	bare.directory.register(source(async () => ({ name: "Ada" })));
	expect(await bare.directory.picture(PERSON)).toBeUndefined();
	// An hour later a successful picture is fetched again.
	const fresh = rig();
	fresh.directory.register(
		source(async () => ({ name: "Ada", pictureUrl: PICTURE_URL })),
	);
	await fresh.directory.picture(PERSON);
	fresh.clock.now += HOUR + 1;
	await fresh.directory.picture(PERSON);
	expect(fresh.fetches).toEqual([PICTURE_URL, PICTURE_URL]);
});

test("the profile migration stores a person's choice of provider and no name, address or picture", () => {
	const source = PRINCIPAL_PROFILE_CHOICES.toString();
	expect(source).toContain("principal_profile_choices");
	expect(source).toContain("principal_id");
	expect(source).toContain("provider");
	expect(source).not.toMatch(/name|url|picture|address/i);
});
