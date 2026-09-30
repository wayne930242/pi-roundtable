import { describe, expect, test } from "bun:test";
import type { Judge, Providers } from "../contract/providers.ts";
import { PluginError, ProviderError } from "../errors.ts";
import { Roundtable } from "../host.ts";
import { ModelJudge } from "../judging/model-judge.ts";
import { silentLogger } from "../log.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import { resolveProviders } from "./providers.ts";

/** What the promise rejected with; undefined when it resolved. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	return undefined;
}

const fixedJudge: Judge = {
	askYesNo: async () => ({ approves: 1 }),
	askChoice: async () => ({ choice: "a", confidence: 1 }),
	askScore: async () => [1],
};

const providing = (
	name: string,
	providers: Partial<Providers>,
): RoundtablePlugin => ({ name, providers, setup: () => ({}) });

describe("resolveProviders", () => {
	test("without plugins, the judge asks the given model and images refuse", async () => {
		const resolved = resolveProviders([], async () => '{"approves": 0.7}');
		expect(resolved.judge).toBeInstanceOf(ModelJudge);
		expect(
			await resolved.judge.askYesNo(
				{},
				{
					approves: { type: "yesno", instructions: "Approve?" },
				},
			),
		).toEqual({ approves: 0.7 });
		expect(await rejection(resolved.images("a cat", []))).toBeInstanceOf(
			ProviderError,
		);
	});

	test("without a judge model, every judgment refuses so callers keep their defaults", async () => {
		const { judge } = resolveProviders([]);
		expect(
			await rejection(
				judge.askScore({}, "effort", {
					type: "score",
					instructions: "",
					criteria: [],
				}),
			),
		).toBeInstanceOf(ProviderError);
	});

	test("a plugin's provider replaces the default for its slot only", () => {
		const images = async () => new Uint8Array([1]);
		const resolved = resolveProviders([
			providing("acme-judge", { judge: fixedJudge }),
			providing("codex", { images }),
		]);
		expect(resolved.judge).toBe(fixedJudge);
		expect(resolved.images).toBe(images);
	});

	test("two plugins filling one slot clash", () => {
		expect(() =>
			resolveProviders([
				providing("acme-judge", { judge: fixedJudge }),
				providing("other", { judge: fixedJudge }),
			]),
		).toThrow(PluginError);
	});
});

describe("Roundtable providers", () => {
	test("a provider-only plugin is valid, and setups read the resolved providers", async () => {
		let seen: Judge | undefined;
		const roundtable = new Roundtable(
			{
				logger: silentLogger(),
				exit: () => {},
			},
			[
				providing("acme-judge", { judge: fixedJudge }),
				{
					name: "reader",
					setup: ({ providers }) => {
						seen = providers.judge;
						return { events: {} };
					},
				},
			],
		);
		await roundtable.run();
		expect(seen).toBe(fixedJudge);
	});
});
