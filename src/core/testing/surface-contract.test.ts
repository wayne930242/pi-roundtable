import { expect, test } from "bun:test";
import type { InboundMessage } from "../contract/channels.ts";
import type { ChatSurface } from "../contract/surface.ts";
import type { Approval } from "../interactions/prompts.ts";
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
		/** Lets anyone answer a prompt, not only the person it is for. */
		openPrompts?: boolean;
		/** Lets the owner answer every prompt, a private conversation's too. */
		ownerAnswersAll?: boolean;
		/** Shows an approval above the person's tier in a private conversation, to wait for the owner. */
		escalatesPrivate?: boolean;
		/** The person's tier; owner by default. */
		tier?: Tier;
	} = {},
): SurfaceContractSubject {
	const seen: SurfaceObservation[] = [];
	/** Each open prompt's settle, and whether the owner may answer it. */
	const open = new Map<
		string,
		{ settle: (answer: Approval) => void; owners: boolean }
	>();
	/**
	 * Answers prompt `id` as `who`: the person, author "1", or the owner "0" where the prompt's
	 * scope escalates to the owners; anyone where prompts are open.
	 */
	const answerAs = (who: string, id: string, approved: boolean) => {
		const prompt = open.get(id);
		const may =
			who === "1" ||
			options.openPrompts ||
			(who === "0" && (prompt?.owners || options.ownerAnswersAll));
		if (may) prompt?.settle(approved ? "approved" : "declined");
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
			confirm: async (title, _message, signal, minTier = "owner") => {
				const theirs = !scope || tierAtLeast(scope.tier, minTier);
				if (!theirs && scope?.escalate === "none" && !options.escalatesPrivate)
					return "expired";
				return new Promise<Approval>((resolve) => {
					const id = `p${++next}`;
					seen.push({ kind: "prompt", id, title });
					const settle = (answer: Approval) => {
						open.delete(id);
						seen.push({ kind: "prompt_closed", id });
						resolve(answer);
					};
					open.set(id, { settle, owners: scope?.escalate !== "none" });
					signal?.addEventListener("abort", () =>
						settle(options.brokenPrompts ? "expired" : "cancelled"),
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

test("the contract catches a surface that lets another person answer an approval", async () => {
	const failures = await checkSurfaceContract(async () =>
		memoryChat({ openPrompts: true }),
	);
	expect(failures.map((failure) => failure.name)).toEqual([
		"another person cannot answer the person's approval",
		"another principal cannot answer for the person in their private conversation, even an owner",
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

test("the contract catches a surface that shows a private approval above the person's tier, to wait for the owners", async () => {
	const failures = await checkSurfaceContract(async () =>
		memoryChat({ tier: "member", escalatesPrivate: true }),
	);
	expect(failures.map((failure) => failure.name)).toEqual([
		"a private conversation's approval above the person's tier goes to no one: it expires at once",
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
