import { afterAll, describe, expect, test } from "bun:test";
import { BASHES, BashRunner } from "./shell-fuzz-bash.ts";
import { type FuzzKind, fuzzLine } from "./shell-fuzz-grammar.ts";
import { shellHoldRule } from "./shell-policy.ts";

/**
 * A seeded, generative version of the differential test: lines composed from the grammar of bash
 * with `sudo marker` planted in random places, run with real bash (3.2 and 5, on a PATH of stubs).
 * The invariant is the rule's one promise: whenever bash runs the stub `sudo`, the line is held.
 * A failure prints the seed; `ROUNDTABLE_SHELL_FUZZ=1 ROUNDTABLE_SHELL_FUZZ_BASE=<seed>` runs that
 * one line again.
 *
 * `ROUNDTABLE_SHELL_FUZZ=<lines>` sets how many lines to run (default 2000, about a minute);
 * `ROUNDTABLE_SHELL_FUZZ_BASE=<seed>` sets the first seed (default 1), the others follow it;
 * `ROUNDTABLE_SHELL_FUZZ_JOBS=<n>` sets how many bash processes run at once (default up to six).
 */

const LINES = Math.max(
	1,
	Number.parseInt(process.env.ROUNDTABLE_SHELL_FUZZ ?? "", 10) || 2000,
);
const BASE =
	Number.parseInt(process.env.ROUNDTABLE_SHELL_FUZZ_BASE ?? "", 10) || 1;
const seeds = Array.from({ length: LINES }, (_, i) => BASE + i);

const runner = new BashRunner();
afterAll(() => runner.close());

const held = (line: string): boolean =>
	shellHoldRule.describe(
		"bash",
		{ command: line },
		{ workspace: runner.workspace, scratchDir: `${runner.workspace}/scratch` },
	) !== undefined;

/** Runs `work` for every item, `runner.size` at a time. */
async function inParallel<T>(
	items: readonly T[],
	work: (item: T) => Promise<void>,
): Promise<void> {
	let next = 0;
	await Promise.all(
		Array.from({ length: runner.size }, async () => {
			while (next < items.length) await work(items[next++] as T);
		}),
	);
}

/** Programs that no generated line may name: nothing the harness runs is destructive. */
const DESTRUCTIVE = new RegExp(
	`\\b(${["rm", "dd", "kill", "pk" + "ill", "kill" + "all", "shutdown", "reboot", "halt", "poweroff", "mkfs", "doas", "chmod", "chown", "mv", "cp", "curl", "wget"].join("|")})\\b`,
);

describe("the generator", () => {
	test("gives the same line for the same seed", () => {
		for (const kind of ["attack", "everyday", "benign"] as const)
			for (let seed = 1; seed <= 50; seed++)
				expect(fuzzLine(seed, kind)).toBe(fuzzLine(seed, kind));
	});

	test("never reaches the real sudo past the stub PATH, over the default seed range", () => {
		const bypass =
			/\bcommand\s+-\w*p|\benv\s+(-\w*i|-\S*\bPATH=)|\benv\s+-P|\/(usr\/)?s?bin\/|\bPATH=|\bhash\b|\b(?:ba)?sh\s+(?:-\S*l\S*|--login)\b/;
		for (const kind of ["attack", "everyday", "benign"] as const)
			for (let seed = 1; seed <= 2000; seed++)
				expect(fuzzLine(seed, kind)).not.toMatch(bypass);
	});

	test("never writes a destructive command or a change to the directory or the PATH", () => {
		for (let seed = 1; seed <= 400; seed++) {
			const line = fuzzLine(seed, "attack");
			expect(line).not.toMatch(DESTRUCTIVE);
			expect(line).not.toMatch(/\bcd\b|\bunset\b|\bexport PATH|\bPATH=/);
		}
	});
});

describe.skipIf(BASHES.length === 0)(
	"bash runs sudo only on a held line",
	() => {
		test("the harness sees bash run the stub", async () => {
			for (const bash of BASHES) {
				expect(await runner.runs(bash, "sudo marker")).toBe(true);
				expect(await runner.runs(bash, "echo 'sudo marker'")).toBe(false);
				expect(
					await runner.runs(
						bash,
						"env nice -n 5 timeout -s KILL 5 sudo marker",
					),
				).toBe(true);
			}
		});

		test("every generated line that runs sudo is held", {
			timeout: 60_000 + LINES * 60,
		}, async () => {
			const missed: string[] = [];
			const executed = new Map<string, number>(BASHES.map((bash) => [bash, 0]));
			let ran = 0;
			const started = Date.now();
			await inParallel(seeds, async (seed) => {
				const line = fuzzLine(seed, "attack");
				let any = false;
				for (const bash of BASHES) {
					if (!(await runner.runs(bash, line))) continue;
					any = true;
					executed.set(bash, (executed.get(bash) ?? 0) + 1);
				}
				if (!any) return;
				ran++;
				if (held(line)) return;
				// A job an earlier line left behind could have written the marker; a real run repeats.
				for (const bash of BASHES)
					if (await runner.runs(bash, line)) {
						missed.push(`seed ${seed}: ${JSON.stringify(line)}`);
						return;
					}
			});
			console.log(
				`shell fuzz: ${LINES} lines from seed ${BASE}, bash ran sudo in ${ran} (${[...executed].map(([bash, n]) => `${bash} ${n}`).join(", ")}), ${missed.length} not held, ${Math.round((Date.now() - started) / 1000)} s`,
			);
			// Lines bash does not run prove nothing: the generator has to keep hitting the stub.
			if (LINES >= 200) expect(ran).toBeGreaterThan(LINES * 0.2);
			expect(missed.slice(0, 20)).toEqual([]);
		});
	},
);

describe("lines that run nothing the rule holds", () => {
	/** How many lines of a kind the rule holds; for an everyday line that is a false positive. */
	function holdRate(kind: FuzzKind): { held: number; examples: string[] } {
		const examples: string[] = [];
		let count = 0;
		for (const seed of seeds) {
			const line = fuzzLine(seed, kind);
			if (!held(line)) continue;
			count++;
			if (examples.length < 3 && line.length < 160)
				examples.push(JSON.stringify(line));
		}
		return { held: count, examples };
	}

	for (const [kind, what] of [
		["everyday", "everyday lines (the plain half of the grammar)"],
		["benign", "harmless lines over the whole grammar"],
	] as const)
		test(`reports the hold rate of ${what}`, () => {
			const { held: count, examples } = holdRate(kind);
			console.log(
				`shell fuzz: ${what}: ${count} of ${LINES} held (${((100 * count) / LINES).toFixed(1)}%)${examples.length ? `, for example ${examples.join(" ")}` : ""}`,
			);
			// A report, not a gate: failing closed holds some lines on purpose.
			expect(count).toBeLessThanOrEqual(LINES);
		});
});
