import { describe, test } from "bun:test";
import type { InboundMessage } from "../contract/channels.ts";
import type { ChatSurface } from "../contract/surface.ts";
import { parseChannelKey } from "../contract/surface.ts";
import type { Approval } from "../domain/owner-prompts.ts";
import type { TurnProgress } from "../domain/progress.ts";
import type { ChannelKey } from "../sessions.ts";
import type { Speaker } from "../speakers.ts";

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
	/**
	 * The person as the speaker of the turns that ask them, given to `surface.prompts`; default an
	 * owner-tier speaker, so every approval is theirs to answer.
	 */
	speaker?: Speaker;
	close?(): Promise<void>;
}

/** One way the subject broke the contract. */
export interface SurfaceContractFailure {
	name: string;
	error: unknown;
}

interface Running {
	subject: SurfaceContractSubject;
	delivered: InboundMessage[];
}

interface Check {
	name: string;
	/** Whether the check applies to this subject; a check that does not is skipped. */
	applies?(subject: SurfaceContractSubject): boolean;
	run(running: Running): Promise<void>;
}

class ContractBroken extends Error {
	override name = "ContractBroken";
}

function expectThat(condition: boolean, message: string): void {
	if (!condition) throw new ContractBroken(message);
}

async function until(
	done: () => boolean,
	what: string,
	ms = 2000,
): Promise<void> {
	const deadline = Date.now() + ms;
	while (!done()) {
		if (Date.now() > deadline)
			throw new ContractBroken(`timed out waiting until ${what}`);
		await Bun.sleep(5);
	}
}

const seen = (running: Running, kind: SurfaceObservation["kind"]) =>
	running.subject.observations().filter((o) => o.kind === kind);

const speakerOf = (subject: SurfaceContractSubject): Speaker =>
	subject.speaker ?? { id: "contract-speaker", name: "Ada", tier: "owner" };

/** The newest prompt the person has seen, once one more than `before` is open. */
async function nextPrompt(running: Running, before: number): Promise<string> {
	await until(
		() => seen(running, "prompt").length > before,
		"the person sees the approval",
	);
	const prompt = seen(running, "prompt").at(-1);
	if (prompt?.kind !== "prompt") throw new ContractBroken("no prompt seen");
	return prompt.id;
}

/** Asks for one approval and answers it as the person does. */
async function approval(running: Running, approved: boolean) {
	const { surface, channel, answer } = running.subject;
	const prompts = surface.prompts?.(channel, speakerOf(running.subject));
	if (!prompts || !answer)
		throw new ContractBroken("the surface shows no prompts");
	const before = seen(running, "prompt").length;
	const result = prompts.confirm("Approve?", "Send the report.");
	await answer(await nextPrompt(running, before), approved);
	return result;
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
			const prompts = surface.prompts?.(channel, speakerOf(running.subject));
			if (!prompts) throw new ContractBroken("the surface shows no prompts");
			const stop = new AbortController();
			const before = seen(running, "prompt").length;
			const result = prompts.confirm("Approve?", "Send it.", stop.signal);
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
];

async function runCheck(
	check: Check,
	make: () => Promise<SurfaceContractSubject>,
): Promise<"passed" | "skipped"> {
	const subject = await make();
	const running: Running = { subject, delivered: [] };
	try {
		if (check.applies && !check.applies(subject)) return "skipped";
		await subject.surface.start((message) => running.delivered.push(message));
		await subject.join?.();
		await check.run(running);
		return "passed";
	} finally {
		await subject.close?.();
		await subject.surface.stop?.();
	}
}

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
 * progress, and resolves approvals as the person answers or as a stopped turn cancels them. Each
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
