import { beforeAll, describe, expect, test } from "bun:test";
import type { ToolTurn } from "../../define.ts";
import type { PendingConfirmation } from "../../domain/conversation.ts";
import { type HoldDescription, type HoldRule, holdChain } from "../../holds.ts";
import type {
	Approval,
	ApprovalOptions,
	LateAnswer,
	Prompts,
	PromptWait,
} from "../../interactions/prompts.ts";
import { useTestLocale } from "../../testing/locale.ts";
import { TEST_OWNER as OWNER } from "../../testing/owner.ts";
import { MAIL } from "./confirmation-fixture.ts";
import { ConfirmationGate, canonicalJson } from "./confirmation-gate.ts";
import { described } from "./hold-lookups.ts";

useTestLocale();
beforeAll(() => useTestLocale());

const turnOf = (signal: AbortSignal | undefined): ToolTurn =>
	({ signal }) as unknown as ToolTurn;

const send = { to: "dana" };

/** The signal while it is live: a hold that decides anew after the withdrawal gives none. */
const live = (withdraw: AbortController) => () =>
	withdraw.signal.aborted ? undefined : withdraw.signal;

/** A hold that describes every mail with `supersede`, as the plugin that caused the call would. */
function withdrawable(supersede: () => AbortSignal | undefined): HoldRule {
	return {
		name: "withdrawable",
		describe: (tool) => (tool === MAIL ? "send an email" : undefined),
		describeInTurn: (tool): HoldDescription | undefined => {
			if (tool !== MAIL) return undefined;
			const signal = supersede();
			return signal
				? { text: "send an email", supersede: signal }
				: "send an email";
		},
	};
}

/** A card the test answers by hand; one that honors `supersede` the way a surface should. */
function card(honors: boolean) {
	const seen: { options?: ApprovalOptions; wait?: PromptWait }[] = [];
	let answer: (value: Approval) => void = () => {};
	const prompts: Prompts = {
		confirm: (_title, _message, _signal, _tier, wait, _details, options) =>
			new Promise<Approval>((resolve) => {
				answer = resolve;
				seen.push({
					...(options ? { options } : {}),
					...(wait ? { wait } : {}),
				});
				if (honors)
					options?.supersede?.addEventListener(
						"abort",
						() => resolve("cancelled"),
						{ once: true },
					);
			}),
		ask: async () => undefined,
	};
	return { prompts, seen, answer: (value: Approval) => answer(value) };
}

function setup(
	signal: () => AbortSignal | undefined,
	pending?: PendingConfirmation,
) {
	const gate = new ConfirmationGate(
		holdChain([withdrawable(signal)]),
		OWNER,
		pending,
	);
	const saved: (PendingConfirmation | undefined)[] = [];
	gate.onHeldChange = (held) => saved.push(held);
	gate.beginTurn("workspace", false);
	return { gate, saved };
}

const decide = (
	gate: ConfirmationGate,
	prompts?: Prompts,
	input: Record<string, unknown> = send,
) =>
	gate.decide(MAIL, input, prompts ? { prompts, asker: "helper" } : undefined, {
		toolTurn: turnOf,
	});

describe("a plugin withdrawing a call while its card waits in the turn", () => {
	test("a surface that closes the card makes the turn read a withdrawal, and nothing stays watched", async () => {
		const withdraw = new AbortController();
		const { gate } = setup(() => withdraw.signal);
		const { prompts, seen } = card(true);
		const deciding = decide(gate, prompts);
		await Bun.sleep(1);
		expect(seen[0]?.options?.supersede).toBe(withdraw.signal);
		expect(gate.watching).toBe(1);
		withdraw.abort("replaced");
		const result = await deciding;
		expect(result.refused).toBe("withdrawn");
		expect(result.approvedOnCard).toBeUndefined();
		expect(result.reason).toContain("withdrawn");
		expect(result.reason).toContain("send an email");
		expect(gate.watching).toBe(0);
		expect(gate.pending()).toBeUndefined();
	});

	test("a surface that ignores the signal still cannot approve it afterwards", async () => {
		const withdraw = new AbortController();
		const { gate } = setup(() => withdraw.signal);
		const { prompts, answer } = card(false);
		const deciding = decide(gate, prompts);
		await Bun.sleep(1);
		withdraw.abort();
		const result = await deciding;
		expect(result.refused).toBe("withdrawn");
		// The card's buttons are still live on that surface: a press answers a turn that moved on.
		answer("approved");
		await Bun.sleep(1);
		expect(result.approvedOnCard).toBeUndefined();
		expect(gate.watching).toBe(0);
	});

	test("an approval that comes first runs the call once, and a later abort changes nothing", async () => {
		const withdraw = new AbortController();
		const { gate, saved } = setup(() => withdraw.signal);
		const { prompts, answer } = card(true);
		const deciding = decide(gate, prompts);
		await Bun.sleep(1);
		answer("approved");
		withdraw.abort();
		const result = await deciding;
		expect(result).toEqual({ approvedOnCard: true });
		expect(gate.watching).toBe(0);
		expect(saved).toEqual([]);
	});

	test("a withdrawal that comes first refuses the call, and an approval after it changes nothing", async () => {
		const withdraw = new AbortController();
		const { gate } = setup(() => withdraw.signal);
		const { prompts, answer } = card(true);
		const deciding = decide(gate, prompts);
		await Bun.sleep(1);
		withdraw.abort();
		answer("approved");
		const result = await deciding;
		expect(result.refused).toBe("withdrawn");
		expect(result.approvedOnCard).toBeUndefined();
	});

	test("a refusal, a stop and a hold-for-message all end the watch they began", async () => {
		for (const answer of ["declined", "cancelled", "unavailable"] as const) {
			const withdraw = new AbortController();
			const { gate } = setup(() => withdraw.signal);
			const { prompts, answer: respond } = card(true);
			const deciding = decide(gate, prompts);
			await Bun.sleep(1);
			respond(answer);
			await deciding;
			// Only a call held for a message can still be withdrawn.
			expect(gate.watching).toBe(answer === "unavailable" ? 1 : 0);
		}
	});

	test("a withdrawal that lands between the card's last word and the turn reading it refuses the call, never holds it again", async () => {
		for (const last of [
			"expired",
			"unavailable",
			"declined",
			"pending",
		] as const) {
			const withdraw = new AbortController();
			const { gate, saved } = setup(() => withdraw.signal);
			const { prompts, answer } = card(false);
			const deciding = decide(gate, prompts);
			await Bun.sleep(1);
			// Both in one tick: the card resolves first, then the plugin aborts before the turn continues.
			answer(last);
			withdraw.abort("replaced");
			const result = await deciding;
			expect(result.refused).toBe("withdrawn");
			expect(gate.pending()).toBeUndefined();
			expect(gate.watching).toBe(0);
			// Held and forgotten at once would be saved as such; a call never held is not.
			expect(saved.length).toBeLessThanOrEqual(1);
		}
	});

	test("a card that fails ends the watch and leaves no listener on the signal", async () => {
		const withdraw = new AbortController();
		let listeners = 0;
		const add = withdraw.signal.addEventListener.bind(withdraw.signal);
		const remove = withdraw.signal.removeEventListener.bind(withdraw.signal);
		withdraw.signal.addEventListener = (...args: Parameters<typeof add>) => {
			listeners++;
			add(...args);
		};
		withdraw.signal.removeEventListener = (
			...args: Parameters<typeof remove>
		) => {
			listeners--;
			remove(...args);
		};
		const { gate } = setup(() => withdraw.signal);
		const failing: Prompts = {
			confirm: () => Promise.reject(new Error("the card could not be shown")),
			ask: async () => undefined,
		};
		await expect(decide(gate, failing)).rejects.toThrow("could not be shown");
		expect(gate.watching).toBe(0);
		expect(listeners).toBe(0);
		// A card that throws at once does the same.
		const throwing: Prompts = {
			confirm: () => {
				throw new Error("no channel");
			},
			ask: async () => undefined,
		};
		await expect(decide(gate, throwing)).rejects.toThrow("no channel");
		expect(gate.watching).toBe(0);
		expect(listeners).toBe(0);
	});

	test("a signal that is not a signal is ignored: the call is held as before", async () => {
		expect(
			described({ text: "t", supersede: "no" as unknown as AbortSignal }, MAIL),
		).toEqual({ action: "t" });
		const withdraw = new AbortController();
		expect(described({ text: "t", supersede: withdraw.signal }, MAIL)).toEqual({
			action: "t",
			supersede: withdraw.signal,
		});
	});
});

describe("a plugin withdrawing a call after its turn stopped waiting", () => {
	/** A turn that gave up on its card: the gate got `pending` and the surface holds the late callback. */
	async function lateCard(withdraw: AbortController) {
		const { gate, saved } = setup(live(withdraw));
		const { prompts, seen, answer } = card(true);
		const deciding = decide(gate, prompts);
		await Bun.sleep(1);
		answer("pending");
		const result = await deciding;
		const late = (answered: LateAnswer) => seen[0]?.wait?.late(answered);
		return { gate, saved, result, late };
	}

	const approval: LateAnswer = {
		kind: "approval",
		approved: true,
		by: "Ada",
		approvedBy: {
			principalId: "p_ada",
			speakerId: "1",
			name: "Ada",
			owner: true,
		},
	};

	test("a withdrawn card's late approval starts no turn and releases nothing", async () => {
		const withdraw = new AbortController();
		const { gate, late, result } = await lateCard(withdraw);
		expect(result.refused).toBe("pending");
		expect(gate.watching).toBe(1);
		withdraw.abort();
		expect(gate.watching).toBe(0);
		// A surface that kept the card open reports an approval: nothing comes of it.
		expect(late(approval)).toBeUndefined();
		gate.beginTurn("workspace", false);
		const again = await decide(gate, undefined);
		expect(again.refused).toBe("held");
		expect(again.approvedBy).toBeUndefined();
	});

	test("an approval that came first releases the call once, and a later abort changes nothing", async () => {
		const withdraw = new AbortController();
		const { gate, late } = await lateCard(withdraw);
		expect(late(approval)).toContain("approved on its card");
		// Approved, and waiting for the model to make the call: still withdrawable.
		expect(gate.watching).toBe(1);
		gate.beginTurn("workspace", false);
		expect(gate.watching).toBe(1);
		const ran = await decide(gate, undefined);
		expect(ran.reason).toBeUndefined();
		expect(ran.approvedBy).toBeDefined();
		// The call was released: nothing is left to withdraw.
		expect(gate.watching).toBe(0);
		withdraw.abort();
		expect(gate.watching).toBe(0);
	});

	test("a call approved late but not yet made is no longer released once its plugin withdraws it", async () => {
		const withdraw = new AbortController();
		const { gate, late } = await lateCard(withdraw);
		expect(late(approval)).toContain("approved on its card");
		withdraw.abort();
		gate.beginTurn("workspace", false);
		const again = await decide(gate, undefined);
		expect(again.refused).toBe("held");
		expect(again.approvedBy).toBeUndefined();
	});

	test("a late refusal ends the watch", async () => {
		const withdraw = new AbortController();
		const { gate, late } = await lateCard(withdraw);
		expect(late({ kind: "approval", approved: false, by: "Ada" })).toContain(
			"declined",
		);
		expect(gate.watching).toBe(0);
	});
});

describe("a plugin withdrawing a call held for a message", () => {
	test("the held call is forgotten, saved so, and a confirming message releases nothing", async () => {
		const withdraw = new AbortController();
		const { gate, saved } = setup(live(withdraw));
		const result = await decide(gate, undefined);
		expect(result.refused).toBe("held");
		expect(gate.pending()?.calls).toHaveLength(1);
		expect(gate.watching).toBe(1);
		gate.endTurn();
		withdraw.abort("replaced");
		expect(gate.pending()).toBeUndefined();
		expect(saved).toEqual([undefined]);
		expect(gate.watching).toBe(0);
		gate.beginTurn("workspace", true);
		const again = await decide(gate, undefined);
		expect(again.refused).toBe("held");
		expect(again.approvedBy).toBeUndefined();
	});

	test("it withdraws only that call and keeps the others held", async () => {
		const withdraw = new AbortController();
		const { gate, saved } = setup(live(withdraw));
		await decide(gate, undefined);
		const other = { to: "lee" };
		// A call whose hold gives no signal.
		withdraw.abort();
		await decide(gate, undefined, other);
		expect(gate.pending()?.calls.map((c) => c.input)).toEqual([
			canonicalJson(other),
		]);
		expect(saved).toEqual([undefined]);
	});

	test("a confirmation that already moved the call to approved is dropped too, whichever comes first", async () => {
		const withdraw = new AbortController();
		const { gate } = setup(live(withdraw));
		await decide(gate, undefined);
		gate.endTurn();
		// The owner confirms in a message: the call is released, not yet made.
		gate.beginTurn("workspace", true);
		withdraw.abort();
		const again = await decide(gate, undefined);
		expect(again.refused).toBe("held");
		expect(again.approvedBy).toBeUndefined();
	});

	test("a call released first runs, and a withdrawal after that is nothing", async () => {
		const withdraw = new AbortController();
		const { gate, saved } = setup(() => withdraw.signal);
		await decide(gate, undefined);
		gate.endTurn();
		gate.beginTurn("workspace", true);
		const ran = await decide(gate, undefined);
		expect(ran.reason).toBeUndefined();
		withdraw.abort();
		expect(saved).toEqual([]);
		expect(gate.watching).toBe(0);
	});

	test("withdrawing again does nothing", async () => {
		const withdraw = new AbortController();
		const { gate, saved } = setup(() => withdraw.signal);
		await decide(gate, undefined);
		withdraw.abort();
		withdraw.abort();
		expect(saved).toHaveLength(1);
	});

	test("a held call whose turn ends unconfirmed leaves no watch behind", async () => {
		const withdraw = new AbortController();
		const { gate } = setup(() => withdraw.signal);
		await decide(gate, undefined);
		gate.endTurn();
		expect(gate.watching).toBe(1);
		// The next message does not confirm it: what it held is dropped.
		gate.beginTurn("workspace", false);
		expect(gate.watching).toBe(0);
	});

	test("a gate that is dropped stops watching", async () => {
		const withdraw = new AbortController();
		const { gate } = setup(() => withdraw.signal);
		await decide(gate, undefined);
		gate.abandon();
		expect(gate.watching).toBe(0);
	});
});

describe("a signal that is already aborted when the hold answers", () => {
	test("refuses the call without opening a card", async () => {
		const withdraw = new AbortController();
		withdraw.abort();
		const { gate } = setup(() => withdraw.signal);
		const { prompts, seen } = card(true);
		const result = await decide(gate, prompts);
		expect(result.refused).toBe("withdrawn");
		expect(seen).toEqual([]);
		expect(gate.pending()).toBeUndefined();
		expect(gate.watching).toBe(0);
	});

	test("drops a confirmation the owner already gave of the call: how a hold withdraws what a restart left held", async () => {
		const heldAt = new Date();
		const stored: PendingConfirmation = {
			selectionId: "workspace",
			heldAt,
			calls: [
				{ tool: MAIL, input: canonicalJson(send), action: "send an email" },
			],
		};
		const withdraw = new AbortController();
		// After a restart the stored call has no signal: a message still confirms it.
		const restored = new ConfirmationGate(
			holdChain([withdrawable(() => undefined)]),
			OWNER,
			stored,
		);
		restored.beginTurn("workspace", true);
		const released = await decide(restored, undefined);
		expect(released.reason).toBeUndefined();
		// The hold describes the repeated call again, now with an aborted signal: refused, whatever was confirmed.
		withdraw.abort();
		const gate = new ConfirmationGate(
			holdChain([withdrawable(() => withdraw.signal)]),
			OWNER,
			stored,
		);
		gate.beginTurn("workspace", true);
		const refused = await decide(gate, undefined);
		expect(refused.refused).toBe("withdrawn");
		expect(refused.approvedBy).toBeUndefined();
		expect(gate.pending()).toBeUndefined();
	});
});
