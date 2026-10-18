import { describe, test } from "bun:test";
import type { ChatSurface } from "../contract/surface.ts";
import { parseChannelKey } from "../contract/surface.ts";
import type { TurnProgress } from "../domain/progress.ts";
import type { Approval } from "../interactions/prompts.ts";
import type {
	Questionnaire,
	QuestionnaireAnswer,
} from "../interactions/questionnaire.ts";
import type { ChannelKey } from "../sessions.ts";
import type { Speaker } from "../speakers.ts";
import { QUESTIONNAIRE_CHECKS } from "./surface-contract-questionnaire.ts";
import {
	answeredOnlyByThem,
	approval,
	ContractBroken,
	expectThat,
	namedApproverAnswers,
	nextPrompt,
	type Running,
	runCheck,
	scopeOf,
	seen,
	speakerOf,
	until,
} from "./surface-contract-support.ts";

/** What the person on a surface's network has seen, as the contract reads it. */
export type SurfaceObservation =
	| { kind: "reply"; text: string; files: readonly string[] }
	| { kind: "typing"; on: boolean }
	| { kind: "stop"; on: boolean }
	| { kind: "progress"; event: TurnProgress }
	| { kind: "prompt"; id: string; title: string }
	| { kind: "prompt_closed"; id: string };

/**
 * A surface under the contract, and one person on its network the contract acts as. The
 * contract starts the surface, then calls `join`; it stops the surface after `close`.
 */
export interface SurfaceContractSubject {
	surface: ChatSurface;
	/** A channel of the surface the person takes part in. */
	channel: ChannelKey;
	/** The person joins `channel`, once the surface has started. */
	join?(): Promise<void>;
	/** The person writes `text` in `channel`; the surface delivers it to the host. */
	write(text: string): Promise<void>;
	/** Everything the person has seen so far, oldest first. */
	observations(): readonly SurfaceObservation[];
	/** The person answers an open approval; without it the prompt checks are skipped. */
	answer?(prompt: string, approved: boolean): Promise<void>;
	/** The person answers an open questionnaire, as shaped for `asks`; without it those checks are skipped. */
	answerQuestionnaire?(
		prompt: string,
		answer: QuestionnaireAnswer,
		questionnaire: Questionnaire,
	): Promise<void>;
	/**
	 * The person as the speaker of the turns that ask them, given to `surface.prompts` as the
	 * scope `promptScope(speaker, visibility)`; default an owner-tier speaker. Every approval the
	 * contract asks for needs exactly the speaker's tier, so it is theirs to answer; one above a
	 * speaker below the owner tier checks that a private conversation escalates to no one.
	 */
	speaker?: Speaker;
	/**
	 * Someone else on the surface's network, another principal and not an owner, who knows the
	 * id of the person's open prompt and answers it; without it the responder-scope check is
	 * skipped.
	 */
	stranger?: SurfaceContractAnswerer;
	/**
	 * An owner on the surface's network, another principal than the person, who knows the id of
	 * the person's open prompt in their private conversation and answers it; without it that
	 * check is skipped.
	 */
	owner?: SurfaceContractAnswerer;
	/**
	 * Another principal, not an owner, who holds the tier of the person's approvals and whom an
	 * approval may name in `approvers`; they know the id of the person's open prompt and answer it.
	 * A surface must report them through `ApprovalOptions.approvedBy`, because the runtime accepts
	 * an approval of a call that names approvers only from one it names. Without it the
	 * named-approver checks are skipped.
	 */
	approver?: SurfaceContractAnswerer & { principalId: string };
	/**
	 * Set by a surface that serves only conversations private to one person, such as the web chat:
	 * it has no shared conversation in which an approval is the named approvers', so it skips that
	 * check and keeps the one that its person alone answers a private conversation's.
	 */
	privateOnly?: boolean;
	close?(): Promise<void>;
}

/** Someone on the network other than the person, who answers a prompt by its id. */
export interface SurfaceContractAnswerer {
	/** They join the surface, once it has started. */
	join?(): Promise<void>;
	answer(prompt: string, approved: boolean): Promise<void>;
	/** They answer an open questionnaire; without it its stranger check is skipped. */
	answerQuestionnaire?(
		prompt: string,
		answer: QuestionnaireAnswer,
		questionnaire: Questionnaire,
	): Promise<void>;
}

/** One way the subject broke the contract. */
export interface SurfaceContractFailure {
	name: string;
	error: unknown;
}

interface Check {
	name: string;
	/** Whether the check applies to this subject; a check that does not is skipped. */
	applies?(subject: SurfaceContractSubject): boolean;
	run(running: Running): Promise<void>;
}

const CHECKS: readonly Check[] = [
	{
		name: "names a surface prefix without a colon, and owns the subject's channel",
		run: async ({ subject }) => {
			const { surface } = subject.surface;
			expectThat(
				surface !== "" && !surface.includes(":"),
				`"${surface}" is not a surface name`,
			);
			expectThat(
				parseChannelKey(subject.channel).surface === surface,
				`${subject.channel} is not a channel of ${surface}`,
			);
		},
	},
	{
		name: "delivers what the person writes, in their channel",
		run: async (running) => {
			await running.subject.write("hello from the contract");
			await until(
				() => running.delivered.length > 0,
				"the surface delivers the message",
			);
			const [message] = running.delivered;
			expectThat(
				message?.channel === running.subject.channel,
				`delivered to ${message?.channel}, not ${running.subject.channel}`,
			);
			expectThat(
				message?.text === "hello from the contract",
				`delivered the text ${JSON.stringify(message?.text)}`,
			);
			expectThat(
				Boolean(message?.messageId) && Boolean(message?.authorId),
				"a delivered message names its id and its author",
			);
			expectThat(message?.authorIsBot === false, "the person is not a bot");
		},
	},
	{
		name: "shows the person every chunk of a reply",
		run: async (running) => {
			const { surface, channel } = running.subject;
			await surface.sendReply(channel, { chunks: ["first part", "second"] });
			await until(
				() => seen(running, "reply").length > 0,
				"the person sees the reply",
			);
			const reply = seen(running, "reply")[0];
			expectThat(
				reply?.kind === "reply" &&
					reply.text.includes("first part") &&
					reply.text.includes("second"),
				"the reply shows both chunks",
			);
		},
	},
	{
		name: "delivers a reply's files when it supports them",
		applies: (subject) => subject.surface.supportsFiles === true,
		run: async (running) => {
			const { surface, channel } = running.subject;
			await surface.sendReply(channel, {
				chunks: ["see the file"],
				files: [{ name: "notes.txt", data: new TextEncoder().encode("hi") }],
			});
			await until(
				() =>
					seen(running, "reply").some(
						(o) => o.kind === "reply" && o.files.includes("notes.txt"),
					),
				"the person receives the file",
			);
		},
	},
	{
		name: "a typing indicator ends when its handle is called, and calling it again is harmless",
		applies: (subject) => subject.surface.startTyping !== undefined,
		run: async (running) => {
			const { surface, channel } = running.subject;
			const stop = surface.startTyping?.(channel);
			stop?.();
			stop?.();
			await until(
				() => seen(running, "typing").some((o) => o.kind === "typing" && !o.on),
				"the person sees typing end",
			);
		},
	},
	{
		name: "a stop control ends when its handle is called, and calling it again is harmless",
		applies: (subject) => subject.surface.showStop !== undefined,
		run: async (running) => {
			const { surface, channel } = running.subject;
			const hide = surface.showStop?.(channel);
			hide?.();
			hide?.();
			await until(
				() => seen(running, "stop").some((o) => o.kind === "stop" && !o.on),
				"the person sees the stop control go",
			);
		},
	},
	{
		name: "shows a running turn's progress",
		applies: (subject) => subject.surface.progress !== undefined,
		run: async (running) => {
			const { surface, channel } = running.subject;
			await surface.progress?.(channel, { type: "text", delta: "Look" });
			await surface.progress?.(channel, {
				type: "tool_start",
				id: "t1",
				tool: "search",
			});
			await until(
				() => seen(running, "progress").length >= 2,
				"the person sees the progress",
			);
		},
	},
	{
		name: "an approval resolves as the person answers it, and closes",
		applies: (subject) =>
			subject.surface.prompts !== undefined && subject.answer !== undefined,
		run: async (running) => {
			const approved = await approval(running, true);
			expectThat(approved === "approved", `approving answered ${approved}`);
			const declined = await approval(running, false);
			expectThat(declined === "declined", `declining answered ${declined}`);
			await until(
				() => seen(running, "prompt_closed").length >= 2,
				"both approvals close",
			);
		},
	},
	{
		name: "a stopped turn's approval resolves cancelled and closes",
		applies: (subject) =>
			subject.surface.prompts !== undefined && subject.answer !== undefined,
		run: async (running) => {
			const { surface, channel } = running.subject;
			const prompts = surface.prompts?.(channel, scopeOf(running.subject));
			if (!prompts) throw new ContractBroken("the surface shows no prompts");
			const stop = new AbortController();
			const before = seen(running, "prompt").length;
			const result = prompts.confirm(
				"Approve?",
				"Send it.",
				stop.signal,
				speakerOf(running.subject).tier,
			);
			const id = await nextPrompt(running, before);
			stop.abort();
			const answer: Approval = await result;
			expectThat(answer === "cancelled", `a stopped turn answered ${answer}`);
			await until(
				() =>
					seen(running, "prompt_closed").some(
						(o) => o.kind === "prompt_closed" && o.id === id,
					),
				"the stopped approval closes",
			);
		},
	},
	{
		name: "an approval its plugin withdraws resolves cancelled and closes; one answered first stays answered",
		applies: (subject) =>
			subject.surface.prompts !== undefined && subject.answer !== undefined,
		run: async (running) => {
			const { surface, channel, answer } = running.subject;
			const prompts = surface.prompts?.(channel, scopeOf(running.subject));
			if (!prompts || !answer)
				throw new ContractBroken("the surface shows no prompts");
			const ask = (supersede: AbortSignal) =>
				prompts.confirm(
					"Approve?",
					"Send it.",
					undefined,
					speakerOf(running.subject).tier,
					undefined,
					undefined,
					{ supersede },
				);
			const closes = (id: string) =>
				seen(running, "prompt_closed").filter(
					(o) => o.kind === "prompt_closed" && o.id === id,
				).length;
			const withdrawn = new AbortController();
			let before = seen(running, "prompt").length;
			const first = ask(withdrawn.signal);
			const firstId = await nextPrompt(running, before);
			withdrawn.abort("replaced by a newer request");
			const result = await Promise.race([
				first,
				Bun.sleep(1000).then(() => "still open" as const),
			]);
			expectThat(
				result === "cancelled",
				`a withdrawn approval answered ${result}`,
			);
			await until(() => closes(firstId) > 0, "the withdrawn approval closes");
			// An answer to the closed approval changes nothing, as for any ended prompt.
			await answer(firstId, true).catch(() => undefined);
			expectThat(closes(firstId) === 1, "the withdrawn approval closed twice");
			// An approval answered before the withdrawal stays answered.
			const later = new AbortController();
			before = seen(running, "prompt").length;
			const second = ask(later.signal);
			const secondId = await nextPrompt(running, before);
			await answer(secondId, true);
			later.abort();
			const approved: Approval = await second;
			expectThat(
				approved === "approved",
				`an answered approval came back ${approved}`,
			);
			await Bun.sleep(20);
			expectThat(closes(secondId) === 1, "the answered approval closed twice");
			// A signal that is already aborted shows nothing.
			const gone = new AbortController();
			gone.abort();
			before = seen(running, "prompt").length;
			const none: Approval = await ask(gone.signal);
			expectThat(
				none === "cancelled",
				`an approval withdrawn before it opened came back ${none}`,
			);
			expectThat(
				seen(running, "prompt").length === before,
				"a withdrawn approval was shown",
			);
		},
	},
	{
		name: "another person cannot answer the person's approval",
		applies: (subject) =>
			subject.surface.prompts !== undefined &&
			subject.answer !== undefined &&
			subject.stranger !== undefined,
		run: (running) =>
			answeredOnlyByThem(running, running.subject.stranger, "shared"),
	},
	{
		name: "another principal cannot answer for the person in their private conversation, even an owner",
		applies: (subject) =>
			subject.surface.prompts !== undefined &&
			subject.answer !== undefined &&
			subject.owner !== undefined,
		run: (running) =>
			answeredOnlyByThem(running, running.subject.owner, "private"),
	},
	{
		name: "a named approver answers an approval instead of the person; the person and another person cannot",
		applies: (subject) =>
			subject.surface.prompts !== undefined &&
			subject.answer !== undefined &&
			subject.stranger !== undefined &&
			subject.approver !== undefined &&
			subject.privateOnly !== true,
		run: namedApproverAnswers,
	},
	{
		name: "a private conversation is answered by its person alone, whoever else a call names",
		applies: (subject) =>
			subject.surface.prompts !== undefined &&
			subject.answer !== undefined &&
			subject.approver !== undefined,
		run: (running) =>
			answeredOnlyByThem(running, running.subject.approver, "private", [
				speakerOf(running.subject).principalId,
				running.subject.approver?.principalId ?? "",
			]),
	},
	{
		name: "a private conversation's approval above the person's tier goes to no one: it comes back at once, unshown",
		applies: (subject) =>
			subject.surface.prompts !== undefined &&
			speakerOf(subject).tier !== "owner",
		run: async (running) => {
			const { surface, channel } = running.subject;
			const prompts = surface.prompts?.(
				channel,
				scopeOf(running.subject, "private"),
			);
			if (!prompts) throw new ContractBroken("the surface shows no prompts");
			const before = seen(running, "prompt").length;
			const answer = await Promise.race([
				prompts.confirm("Approve?", "Delete the notes.", undefined, "owner"),
				Bun.sleep(1000).then(() => "still open" as const),
			]);
			expectThat(
				// `expired` is what surfaces answered before `unavailable` existed.
				answer === "unavailable" || answer === "expired",
				`an approval no one may answer came back ${answer}`,
			);
			expectThat(
				seen(running, "prompt").length === before,
				"an approval no one may answer was shown",
			);
		},
	},
	...QUESTIONNAIRE_CHECKS,
];

/**
 * Runs the chat surface contract on fresh subjects from `make`, one per check, and returns the
 * checks the surface broke. `describeSurfaceContract` registers the same checks as tests.
 */
export async function checkSurfaceContract(
	make: () => Promise<SurfaceContractSubject>,
): Promise<SurfaceContractFailure[]> {
	const failures: SurfaceContractFailure[] = [];
	for (const check of CHECKS) {
		try {
			await runCheck(check, make);
		} catch (error) {
			failures.push({ name: check.name, error });
		}
	}
	return failures;
}

/**
 * Registers the chat surface contract as one test per check, under `name`: the surface names a
 * prefix and owns its channel, delivers what its person writes, shows every chunk of a reply, and,
 * where it offers them, delivers files, ends typing and stop controls idempotently, shows
 * progress, resolves approvals as the person answers or as a stopped turn cancels them, closes
 * one its plugin withdraws (`ApprovalOptions.supersede`) as cancelled, ignores
 * another person's answer to the person's approval, and, in a private conversation, an owner's
 * too, and lets an approval above the person's tier there come back at once, shown to no one.
 * Where it can name approvers, an approval that does is answered by them, reported as the
 * approver, and not by the person or another person, and a private conversation's is answered by
 * its person alone, whoever the call names besides them. A subject that gives
 * `answerQuestionnaire` must declare `asks`, and then questionnaires keep the same rules. Each
 * check gets a fresh subject from `make`; a check for an optional part the surface lacks passes.
 */
export function describeSurfaceContract(
	name: string,
	make: () => Promise<SurfaceContractSubject>,
): void {
	describe(`${name} keeps the chat surface contract`, () => {
		for (const check of CHECKS)
			test(check.name, async () => {
				await runCheck(check, make);
			});
	});
}
