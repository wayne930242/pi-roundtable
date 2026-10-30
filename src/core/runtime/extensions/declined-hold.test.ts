import { beforeAll, describe, expect, test } from "bun:test";
import type { ToolTurn } from "../../define.ts";
import { type HoldRule, holdChain } from "../../holds.ts";
import type {
	Approval,
	LateAnswer,
	Prompts,
	PromptWait,
} from "../../interactions/prompts.ts";
import { useTestLocale } from "../../testing/locale.ts";
import { TEST_OWNER as OWNER } from "../../testing/owner.ts";
import { MAIL } from "./confirmation-fixture.ts";
import { ConfirmationGate } from "./confirmation-gate.ts";
import { described } from "./hold-lookups.ts";

useTestLocale();
beforeAll(() => useTestLocale());

const turn = { toolTurn: () => ({}) as unknown as ToolTurn };
const send = { to: "dana" };

/** A hold that opens its own approval notice for a mail, as a plugin that closes it on a decline would. */
function noticing(
	onDeclined: (() => void | Promise<void>) | undefined,
	supersede?: AbortSignal,
): HoldRule {
	return {
		name: "noticing",
		describe: (tool) => (tool === MAIL ? "send an email" : undefined),
		describeInTurn: (tool) =>
			tool === MAIL
				? {
						text: "send an email",
						...(onDeclined ? { onDeclined } : {}),
						...(supersede ? { supersede } : {}),
					}
				: undefined,
	};
}

/** A card the test answers by hand; `wait` is the surface's late callback. */
function card() {
	let answer: (value: Approval) => void = () => {};
	let wait: PromptWait | undefined;
	const prompts: Prompts = {
		confirm: (_title, _message, _signal, _tier, given) =>
			new Promise<Approval>((resolve) => {
				answer = resolve;
				wait = given;
			}),
		ask: async () => undefined,
	};
	return {
		prompts,
		answer: (value: Approval) => answer(value),
		late: (given: LateAnswer) => wait?.late(given),
	};
}

function setup(rule: HoldRule) {
	const gate = new ConfirmationGate(holdChain([rule]), OWNER);
	gate.beginTurn("workspace", false);
	return gate;
}

const decide = (gate: ConfirmationGate, prompts: Prompts) =>
	gate.decide(MAIL, send, { prompts, asker: "helper" }, turn);

describe("a plugin told that the card of its held call was declined", () => {
	test("a declined card calls onDeclined once and the call is refused", async () => {
		let declined = 0;
		const gate = setup(
			noticing(() => {
				declined += 1;
			}),
		);
		const { prompts, answer } = card();
		const deciding = decide(gate, prompts);
		await Bun.sleep(1);
		answer("declined");
		const result = await deciding;
		expect(result.refused).toBe("declined");
		expect(declined).toBe(1);
	});

	test("an approved, unanswered or cancelled card does not", async () => {
		for (const answered of ["approved", "pending", "cancelled"] as const) {
			let declined = 0;
			const gate = setup(
				noticing(() => {
					declined += 1;
				}),
			);
			const { prompts, answer } = card();
			const deciding = decide(gate, prompts);
			await Bun.sleep(1);
			answer(answered);
			await deciding;
			expect(declined).toBe(0);
		}
	});

	test("a card declined after the turn stopped waiting calls it, an approval then does not", async () => {
		let declined = 0;
		const gate = setup(
			noticing(() => {
				declined += 1;
			}),
		);
		const first = card();
		const deciding = decide(gate, first.prompts);
		await Bun.sleep(1);
		first.answer("pending");
		expect((await deciding).refused).toBe("pending");
		expect(declined).toBe(0);
		expect(
			first.late({ kind: "approval", approved: false, by: "Ada" }),
		).toContain("declined");
		expect(declined).toBe(1);

		const gate2 = setup(
			noticing(() => {
				declined += 1;
			}),
		);
		const second = card();
		const again = decide(gate2, second.prompts);
		await Bun.sleep(1);
		second.answer("pending");
		await again;
		second.late({
			kind: "approval",
			approved: true,
			by: "Ada",
			approvedBy: {
				principalId: "p_ada",
				speakerId: "1",
				name: "Ada",
				owner: true,
			},
		});
		expect(declined).toBe(1);
	});

	test("a call its plugin withdrew is not reported as declined", async () => {
		let declined = 0;
		const withdraw = new AbortController();
		const gate = setup(
			noticing(() => {
				declined += 1;
			}, withdraw.signal),
		);
		const { prompts, answer } = card();
		const deciding = decide(gate, prompts);
		await Bun.sleep(1);
		withdraw.abort("replaced");
		answer("declined");
		expect((await deciding).refused).toBe("withdrawn");
		expect(declined).toBe(0);
	});

	test("a hook that throws or rejects changes nothing: the call is refused and nothing is left unhandled", async () => {
		for (const hook of [
			() => {
				throw new Error("notice gone");
			},
			() => Promise.reject(new Error("notice gone")),
		]) {
			const gate = setup(noticing(hook));
			const { prompts, answer } = card();
			const deciding = decide(gate, prompts);
			await Bun.sleep(1);
			answer("declined");
			expect((await deciding).refused).toBe("declined");
			await Bun.sleep(1);
		}
	});

	test("something that is not a function is ignored", () => {
		expect(
			described({ text: "t", onDeclined: "no" as unknown as () => void }, MAIL),
		).toEqual({ action: "t" });
		const hook = () => {};
		expect(described({ text: "t", onDeclined: hook }, MAIL)).toEqual({
			action: "t",
			onDeclined: hook,
		});
	});
});
