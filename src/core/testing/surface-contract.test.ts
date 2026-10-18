import { expect, test } from "bun:test";
import type { InboundMessage } from "../contract/channels.ts";
import type { ChatSurface } from "../contract/surface.ts";
import type { Approval, ApprovedBy } from "../interactions/prompts.ts";
import type { QuestionnaireAnswer } from "../interactions/questionnaire.ts";
import { type Tier, tierAtLeast } from "../speakers.ts";
import {
	checkSurfaceContract,
	describeSurfaceContract,
	type SurfaceContractSubject,
	type SurfaceObservation,
} from "./surface-contract.ts";

/** An in-memory chat that keeps the contract: what the host asks of it is what its person sees. */
function memoryChat(
	options: {
		files?: boolean;
		brokenPrompts?: boolean;
		/** Leaves an approval open when its plugin withdraws the call. */
		ignoresSupersede?: boolean;
		/** Lets anyone answer a prompt, not only the person it is for. */
		openPrompts?: boolean;
		/** Lets the owner answer every prompt, a private conversation's too. */
		ownerAnswersAll?: boolean;
		/** Shows an approval above the person's tier in a private conversation, to wait for the owner. */
		escalatesPrivate?: boolean;
		/** The person's tier; owner by default. */
		tier?: Tier;
		/** Lets the person answer an approval that names others, as if it named no one. */
		ignoresApprovers?: boolean;
		/** Lets a named approver answer in a private conversation, where its person alone answers. */
		approversInPrivate?: boolean;
		/** Does not report who approved an approval that names approvers. */
		silentApprovers?: boolean;
	} = {},
): SurfaceContractSubject {
	const seen: SurfaceObservation[] = [];
	/** Each open prompt's settle, whether the owner may answer it, and the approvers it names. */
	const open = new Map<
		string,
		{
			settle: (answer: Approval) => void;
			owners: boolean;
			approvers?: readonly string[];
			approvedBy?(by: ApprovedBy): void;
		}
	>();
	/**
	 * Answers prompt `id` as `who`: the person, author "1", or the owner "0" where the prompt's
	 * scope escalates to the owners; anyone where prompts are open.
	 */
	const answerAs = (who: string, id: string, approved: boolean) => {
		const prompt = open.get(id);
		const named = prompt?.approvers;
		const may =
			(who === "1" && (!named || options.ignoresApprovers)) ||
			options.openPrompts ||
			named?.includes(who) ||
			(who === "0" && (prompt?.owners || options.ownerAnswersAll));
		if (!may) return;
		if (approved && named?.includes(who) && !options.silentApprovers)
			prompt?.approvedBy?.({ principalId: who, speakerId: who, name: who });
		prompt?.settle(approved ? "approved" : "declined");
	};
	let deliver: ((message: InboundMessage) => void) | undefined;
	let next = 0;
	const surface: ChatSurface = {
		surface: "memory",
		...(options.files ? { supportsFiles: true } : {}),
		start: async (given) => {
			deliver = given;
		},
		sendReply: async (_channel, reply) =>
			void seen.push({
				kind: "reply",
				text: reply.chunks.join("\n"),
				files: (reply.files ?? []).map((file) => file.name),
			}),
		startTyping: () => {
			seen.push({ kind: "typing", on: true });
			let on = true;
			return () => {
				if (on) seen.push({ kind: "typing", on: false });
				on = false;
			};
		},
		progress: (_channel, event) => void seen.push({ kind: "progress", event }),
		prompts: (_channel, scope) => ({
			confirm: async (
				title,
				_message,
				signal,
				minTier = "owner",
				_wait,
				_details,
				given,
			) => {
				const theirs = !scope || tierAtLeast(scope.tier, minTier);
				if (!theirs && scope?.escalate === "none" && !options.escalatesPrivate)
					return "unavailable";
				if (given?.supersede?.aborted && !options.ignoresSupersede)
					return "cancelled";
				return new Promise<Approval>((resolve) => {
					const id = `p${++next}`;
					seen.push({ kind: "prompt", id, title });
					const settle = (answer: Approval) => {
						open.delete(id);
						seen.push({ kind: "prompt_closed", id });
						resolve(answer);
					};
					const shared = scope?.escalate !== "none";
					open.set(id, {
						settle,
						owners: shared,
						...(given?.approvers && (shared || options.approversInPrivate)
							? { approvers: given.approvers }
							: {}),
						...(given?.approvedBy ? { approvedBy: given.approvedBy } : {}),
					});
					signal?.addEventListener("abort", () =>
						settle(options.brokenPrompts ? "expired" : "cancelled"),
					);
					if (!options.ignoresSupersede)
						given?.supersede?.addEventListener(
							"abort",
							() => open.has(id) && settle("cancelled"),
						);
				});
			},
			ask: async () => undefined,
		}),
	};
	return {
		surface,
		channel: "memory:room",
		write: async (text) =>
			deliver?.({
				channel: "memory:room",
				messageId: `m${++next}`,
				authorId: "1",
				authorName: "Ada",
				authorIsBot: false,
				isDirect: true,
				mentionsBot: false,
				repliesToBot: false,
				text,
				attachments: [],
			}),
		observations: () => seen,
		answer: async (id, approved) => answerAs("1", id, approved),
		speaker: {
			id: "1",
			name: "Ada",
			tier: options.tier ?? "owner",
			principalId: "1",
		},
		stranger: { answer: async (id, approved) => answerAs("2", id, approved) },
		owner: { answer: async (id, approved) => answerAs("0", id, approved) },
		approver: {
			principalId: "3",
			answer: async (id, approved) => answerAs("3", id, approved),
		},
	};
}

describeSurfaceContract("an in-memory chat", async () => memoryChat());
describeSurfaceContract("an in-memory chat with files", async () =>
	memoryChat({ files: true }),
);
describeSurfaceContract("an in-memory chat for a member", async () =>
	memoryChat({ tier: "member" }),
);

test("the contract catches a surface whose cancelled card does not say cancelled", async () => {
	const failures = await checkSurfaceContract(async () =>
		memoryChat({ brokenPrompts: true }),
	);
	expect(failures.map((failure) => failure.name)).toEqual([
		"a stopped turn's approval resolves cancelled and closes",
	]);
});

test("the contract catches a surface that leaves an approval open when its plugin withdraws the call", async () => {
	const failures = await checkSurfaceContract(async () =>
		memoryChat({ ignoresSupersede: true }),
	);
	expect(failures.map((failure) => failure.name)).toEqual([
		"an approval its plugin withdraws resolves cancelled and closes; one answered first stays answered",
	]);
});

test("the contract catches a surface that lets another person answer an approval", async () => {
	const failures = await checkSurfaceContract(async () =>
		memoryChat({ openPrompts: true }),
	);
	expect(failures.map((failure) => failure.name)).toEqual([
		"another person cannot answer the person's approval",
		"another principal cannot answer for the person in their private conversation, even an owner",
		"a named approver answers an approval instead of the person; the person and another person cannot",
		"a private conversation is answered by its person alone, whoever else a call names",
	]);
});

test("the contract catches a surface where an owner answers for the person in their private conversation", async () => {
	const failures = await checkSurfaceContract(async () =>
		memoryChat({ ownerAnswersAll: true }),
	);
	expect(failures.map((failure) => failure.name)).toEqual([
		"another principal cannot answer for the person in their private conversation, even an owner",
	]);
});

test("the contract catches a surface where the person answers an approval that names others", async () => {
	const failures = await checkSurfaceContract(async () =>
		memoryChat({ ignoresApprovers: true }),
	);
	expect(failures.map((failure) => failure.name)).toEqual([
		"a named approver answers an approval instead of the person; the person and another person cannot",
	]);
});

test("the contract catches a surface where a named approver answers in a private conversation", async () => {
	const failures = await checkSurfaceContract(async () =>
		memoryChat({ approversInPrivate: true }),
	);
	expect(failures.map((failure) => failure.name)).toEqual([
		"a private conversation is answered by its person alone, whoever else a call names",
	]);
});

test("the contract catches a surface that does not report the named approver who answered", async () => {
	const failures = await checkSurfaceContract(async () =>
		memoryChat({ silentApprovers: true }),
	);
	expect(failures.map((failure) => failure.name)).toEqual([
		"a named approver answers an approval instead of the person; the person and another person cannot",
	]);
});

test("the contract skips the named-approver checks for a surface that names no approver, and the shared one for a private-only surface", async () => {
	const { approver: _approver, ...without } = memoryChat();
	expect(await checkSurfaceContract(async () => ({ ...without }))).toEqual([]);
	expect(
		await checkSurfaceContract(async () => ({
			...memoryChat({ ignoresApprovers: true }),
			privateOnly: true,
		})),
	).toEqual([]);
});

test("the contract catches a surface that shows a private approval above the person's tier, to wait for the owners", async () => {
	const failures = await checkSurfaceContract(async () =>
		memoryChat({ tier: "member", escalatesPrivate: true }),
	);
	expect(failures.map((failure) => failure.name)).toEqual([
		"a private conversation's approval above the person's tier goes to no one: it comes back at once, unshown",
	]);
});

test("the contract catches a surface that delivers nothing", async () => {
	const failures = await checkSurfaceContract(async () => ({
		...memoryChat(),
		write: async () => undefined,
	}));
	expect(failures.map((failure) => failure.name)).toContain(
		"delivers what the person writes, in their channel",
	);
});

test("the contract catches a subject that answers questionnaires but declares no asks", async () => {
	const failures = await checkSurfaceContract(async () => ({
		...memoryChat(),
		answerQuestionnaire: async () => undefined,
	}));
	expect(failures.map((failure) => failure.name)).toEqual(
		[
			"a questionnaire resolves as the person answers it, keeps a blank question blank, and closes",
			"a stopped turn's questionnaire resolves with no answer and closes",
			"another person cannot answer the person's questionnaire",
		].filter((name) => !name.startsWith("another")),
	);
});

test("the contract catches a surface where another person answers a questionnaire", async () => {
	/** A chat whose questionnaire any answer settles, the person's or not. */
	const open = memoryChat();
	const seen = open.observations() as SurfaceObservation[];
	const waiting = new Map<string, (a: QuestionnaireAnswer) => void>();
	let next = 0;
	const base = open.surface;
	const surface: ChatSurface = {
		...base,
		prompts: (channel, scope) => {
			const prompts = base.prompts?.(channel, scope);
			if (!prompts) throw new Error("no prompts");
			return {
				...prompts,
				asks: { questions: 4, previews: true, note: true },
				questionnaire: (_title, _set, signal) =>
					new Promise((resolve) => {
						const id = `q${++next}`;
						seen.push({ kind: "prompt", id, title: "Questions" });
						const settle = (answer: QuestionnaireAnswer | undefined) => {
							waiting.delete(id);
							seen.push({ kind: "prompt_closed", id });
							resolve(answer);
						};
						waiting.set(id, settle);
						signal?.addEventListener("abort", () => settle(undefined));
					}),
			};
		},
	};
	const answer = async (id: string, given: QuestionnaireAnswer) =>
		waiting.get(id)?.(given);
	const failures = await checkSurfaceContract(async () => ({
		...open,
		surface,
		answerQuestionnaire: answer,
		stranger: { answer: async () => undefined, answerQuestionnaire: answer },
	}));
	expect(failures.map((failure) => failure.name)).toEqual([
		"another person cannot answer the person's questionnaire",
	]);
});
