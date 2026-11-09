import type {
	ConversationTurnInput,
	ConversationTurns,
	InboundMessage,
} from "pi-roundtable";
import type { WebChatLimits } from "../chat.ts";
import { type FakeSocket, speakerOf, TEST_LIMITS, testChat } from "./fakes.ts";

/** A chat whose turns are recorded and answered at once, with its claim and surface linked. */
export async function linked(
	answer = "done",
	during?: (input: ConversationTurnInput) => Promise<void>,
) {
	const turns: ConversationTurnInput[] = [];
	const runner: ConversationTurns = {
		run: async (input) => {
			turns.push(input);
			await during?.(input);
			await registryOf().register({
				key: input.channel,
				kind: input.kind,
				visibility: input.conversation?.visibility ?? "shared",
				...(input.conversation?.visibility === "private"
					? { principalId: input.speaker.principalId }
					: {}),
				...(input.conversation?.title
					? { title: input.conversation.title }
					: {}),
			});
			const result = { ok: true as const, text: answer };
			await input.reply?.(result);
			return result;
		},
	};
	const harness = testChat({ turns: () => runner });
	const registryOf = () => harness.registry;
	const claim = harness.chat.claim();
	const runs: Promise<void>[] = [];
	await harness.chat.surface.start((message: InboundMessage) => {
		const admission = claim.admit({
			...message,
			speaker: speakerOf(message.authorId),
		});
		if (admission?.kind === "turn") runs.push(admission.run());
	});
	const settled = async () => {
		await Promise.all(runs.splice(0));
	};
	return { ...harness, claim, turns, settled };
}

/** A chat whose turns wait until `finish()`, so they stay running; `fail` makes each turn throw. */
export async function gated(
	limits: Partial<WebChatLimits> = {},
	options: { fail?: boolean; start?: boolean } = {},
) {
	const turns: ConversationTurnInput[] = [];
	let open = Promise.withResolvers<void>();
	const runner: ConversationTurns = {
		run: async (input) => {
			turns.push(input);
			await harness.registry.register({
				key: input.channel,
				kind: input.kind,
				visibility: "private",
				principalId: input.speaker.principalId,
			});
			await open.promise;
			if (options.fail) throw new Error("the model is down");
			return { ok: true as const, text: "done" };
		},
	};
	let clock = 0;
	const harness = testChat({
		turns: () => runner,
		limits: { ...TEST_LIMITS, ...limits },
		now: () => clock,
	});
	const claim = harness.chat.claim();
	const runs: Promise<void>[] = [];
	const start = () =>
		harness.chat.surface.start((message: InboundMessage) => {
			const admission = claim.admit({
				...message,
				speaker: speakerOf(message.authorId),
			});
			if (admission?.kind === "turn")
				runs.push(admission.run().catch(() => undefined));
		});
	if (options.start !== false) await start();
	/** Lets every waiting turn end, and waits for them. */
	const finish = async () => {
		open.resolve();
		await Promise.all(runs.splice(0));
		open = Promise.withResolvers<void>();
	};
	const errors = (socket: FakeSocket) =>
		socket.frames.filter((f) => f.type === "error");
	const accepted = (socket: FakeSocket) =>
		socket.frames.flatMap((f) => (f.type === "accepted" ? [f] : []));
	return {
		...harness,
		turns,
		finish,
		start,
		errors,
		accepted,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}
