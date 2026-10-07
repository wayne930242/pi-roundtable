import { describe, expect, test } from "bun:test";
import type { Judge, Providers } from "../contract/providers.ts";
import { PluginError, ProviderError } from "../errors.ts";
import { Roundtable } from "../host.ts";
import { ModelJudge } from "../judging/model-judge.ts";
import { silentLogger } from "../log.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import { fillsImages, resolveProviders } from "./providers.ts";

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

	test("names the slots a plugin fills, so a default is told from a provider without calling it", () => {
		expect([...resolveProviders([]).filled]).toEqual([]);
		expect([
			...resolveProviders([providing("acme-judge", { judge: fixedJudge })])
				.filled,
		]).toEqual(["judge"]);
		expect([
			...resolveProviders([
				providing("acme-judge", { judge: fixedJudge }),
				providing("codex", { images: async () => new Uint8Array() }),
			]).filled,
		]).toEqual(["judge", "images"]);
	});

	test("the runtime slot refuses by default, and a plugin fills it with a factory", () => {
		const { runtime, filled } = resolveProviders([]);
		expect(() => runtime({} as never)).toThrow(ProviderError);
		expect(() => runtime({} as never)).toThrow(
			"the runtime plugin builds the Pi runtime when no plugin fills the runtime slot",
		);
		expect(filled.has("runtime")).toBe(false);
		const factory = () => {
			throw new Error("not built here");
		};
		const resolved = resolveProviders([
			providing("echo", { runtime: factory }),
		]);
		expect(resolved.runtime).toBe(factory);
		expect([...resolved.filled]).toEqual(["runtime"]);
	});

	test("fillsImages is true only for a plugin that fills the images slot", () => {
		expect(fillsImages([])).toBe(false);
		expect(fillsImages([providing("acme-judge", { judge: fixedJudge })])).toBe(
			false,
		);
		expect(
			fillsImages([
				providing("codex", { images: async () => new Uint8Array() }),
			]),
		).toBe(true);
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
		await roundtable.shutdown("test");
		expect(seen).toBe(fixedJudge);
	});
});

describe("an unknown provider slot", () => {
	const unknown = (slot: string): RoundtablePlugin =>
		providing("study", { [slot]: async () => new Uint8Array() });

	test("is refused, naming the valid slots and the nearest one", () => {
		const error = (() => {
			try {
				resolveProviders([unknown("image")]);
			} catch (e) {
				return e;
			}
		})();
		expect(error).toBeInstanceOf(PluginError);
		expect((error as Error).message).toBe(
			'plugin study: unknown provider slot "image". Did you mean "images"? The slots are judge, images, runtime.',
		);
	});

	test("is refused even when no slot is near, and before any plugin is set up", async () => {
		expect(() => resolveProviders([unknown("zzzzzz")])).toThrow(
			"The slots are judge, images, runtime.",
		);
		let setUp = false;
		const roundtable = new Roundtable({ logger: silentLogger() }, [
			{
				name: "study",
				providers: { zzzzzz: () => {} } as never,
				setup: () => {
					setUp = true;
					return {};
				},
			},
		]);
		expect(await rejection(roundtable.run())).toBeInstanceOf(PluginError);
		expect(setUp).toBe(false);
	});
});
