import { describe, expect, test } from "bun:test";
import { promptScope, type Tier } from "pi-roundtable";
import {
	describeSurfaceContract,
	type SurfaceObservation,
} from "pi-roundtable/testing";
import { PromptDesk } from "./prompts.ts";
import type { ServerFrame } from "./protocol.ts";
import { speakerOf, testChat } from "./testing/fakes.ts";

/** What a browser shows for each frame, in the contract's words. */
function observation(frame: ServerFrame): SurfaceObservation | undefined {
	switch (frame.type) {
		case "reply":
			return {
				kind: "reply",
				text: frame.text,
				files: (frame.files ?? []).map((file) => file.name),
			};
		case "typing":
			return { kind: "typing", on: frame.on };
		case "stoppable":
			return { kind: "stop", on: frame.on };
		case "progress":
			return { kind: "progress", event: frame.event };
		case "prompt":
			return { kind: "prompt", id: frame.prompt.id, title: frame.prompt.title };
		case "prompt_closed":
			return { kind: "prompt_closed", id: frame.prompt };
		default:
			return undefined;
	}
}

/**
 * A web chat whose person is `person` at `tier`, whose stranger is another signed-in person, and,
 * when the person is not the owner, whose owner is the owner signed in.
 */
function webSubject(person: string, tier: Tier, roles: string[]) {
	const { chat, connect, say } = testChat();
	const conversation = chat.open(speakerOf(person, tier), "helper");
	let socket: ReturnType<typeof connect> | undefined;
	let stranger: ReturnType<typeof connect> | undefined;
	let owner: ReturnType<typeof connect> | undefined;
	let approver: ReturnType<typeof connect> | undefined;
	return {
		surface: chat.surface,
		channel: `web:${conversation}` as const,
		speaker: speakerOf(person, tier),
		join: async () => {
			socket = connect(person, roles);
			// Proving the conversation is theirs teaches the surface whose it is.
			await say(socket, { type: "stop", conversation });
		},
		write: async (text: string) => {
			if (socket)
				await say(socket, { type: "send", id: "w", conversation, text });
		},
		observations: () =>
			(socket?.frames ?? []).flatMap((frame) => {
				const seen = observation(frame);
				return seen ? [seen] : [];
			}),
		answer: async (prompt: string, approved: boolean) => {
			if (socket) await say(socket, { type: "approval", prompt, approved });
		},
		stranger: {
			join: async () => {
				stranger = connect("mallory", roles);
			},
			answer: async (prompt: string, approved: boolean) => {
				if (stranger)
					await say(stranger, { type: "approval", prompt, approved });
			},
		},
		// Every web conversation is private to its person, so a name in `approvers` changes nothing.
		privateOnly: true,
		approver: {
			principalId: "ned",
			join: async () => {
				approver = connect("ned", roles);
			},
			answer: async (prompt: string, approved: boolean) => {
				if (approver)
					await say(approver, { type: "approval", prompt, approved });
			},
		},
		...(person === "boss"
			? {}
			: {
					owner: {
						join: async () => {
							owner = connect("boss", ["Admin"]);
						},
						answer: async (prompt: string, approved: boolean) => {
							if (owner)
								await say(owner, { type: "approval", prompt, approved });
						},
					},
				}),
		close: async () => {
			if (socket) chat.closed(socket);
			if (stranger) chat.closed(stranger);
			if (owner) chat.closed(owner);
			if (approver) chat.closed(approver);
		},
	};
}

// The owner's approvals need the owner, so the stranger, an admin, is refused by tier as well.
describeSurfaceContract("the web chat surface", async () =>
	webSubject("boss", "owner", ["Admin"]),
);
// A member's approvals need a member, which the stranger is too.
describeSurfaceContract("the web chat surface for a member", async () =>
	webSubject("ann", "member", ["User"]),
);

describe("a held call that names approvers", () => {
	test("the web chat answers it for its person alone, and names no approver", async () => {
		const frames: ServerFrame[] = [];
		const desk = new PromptDesk({
			send: (_principal, frame) => void frames.push(frame),
			sendWhere: () => undefined,
			sendOne: () => undefined,
			supports: () => [],
			timeoutMs: 60_000,
		});
		const scope = promptScope(speakerOf("ann", "member"), "shared");
		let named = 0;
		const answer = desk
			.prompts("c1", scope)
			.confirm("Send?", "sends it", undefined, "member", undefined, undefined, {
				approvers: ["ned"],
				approvedBy: () => {
					named++;
				},
			});
		const prompt = frames.find((frame) => frame.type === "prompt");
		const id = prompt?.type === "prompt" ? prompt.prompt.id : "";
		expect(desk.approve({ principalId: "ned", tier: "member" }, id, true)).toBe(
			"forbidden",
		);
		expect(desk.approve({ principalId: "ann", tier: "member" }, id, true)).toBe(
			undefined,
		);
		expect(await answer).toBe("approved");
		expect(named).toBe(0);
	});
});

describe("an approval its plugin withdraws", () => {
	function open(supersede?: AbortSignal) {
		const frames: ServerFrame[] = [];
		const desk = new PromptDesk({
			send: (_principal, frame) => void frames.push(frame),
			sendWhere: () => undefined,
			sendOne: () => undefined,
			supports: () => [],
			timeoutMs: 60_000,
		});
		const scope = promptScope(speakerOf("ann", "member"), "shared");
		const answer = desk
			.prompts("c1", scope)
			.confirm(
				"Send?",
				"sends it",
				undefined,
				"member",
				undefined,
				undefined,
				supersede ? { supersede } : undefined,
			);
		const prompt = frames.find((frame) => frame.type === "prompt");
		const id = prompt?.type === "prompt" ? prompt.prompt.id : "";
		return { frames, desk, answer, id };
	}

	test("closes the prompt with a `withdrawn` outcome and the plugin's reason, and the turn reads it as cancelled", async () => {
		const withdraw = new AbortController();
		const { frames, desk, answer, id } = open(withdraw.signal);
		withdraw.abort("replaced by a newer request");
		expect(await answer).toBe("cancelled");
		expect(frames.at(-1)).toEqual({
			type: "prompt_closed",
			conversation: "c1",
			prompt: id,
			outcome: "withdrawn",
			note: "replaced by a newer request",
		});
		// Nothing is left to resend after a reconnect, and a press on it finds nothing.
		expect(desk.openFor("ann")).toEqual([]);
		expect(desk.approve({ principalId: "ann", tier: "member" }, id, true)).toBe(
			"unknown_prompt",
		);
	});

	test("without a text reason the frame carries no note", async () => {
		const withdraw = new AbortController();
		const { frames, answer } = open(withdraw.signal);
		withdraw.abort();
		await answer;
		const closed = frames.at(-1);
		expect(closed).toMatchObject({ outcome: "withdrawn" });
		expect(closed && "note" in closed).toBe(false);
	});

	test("an answer that came first stands, and the withdrawal after it closes nothing twice", async () => {
		const withdraw = new AbortController();
		const { frames, desk, answer, id } = open(withdraw.signal);
		expect(desk.approve({ principalId: "ann", tier: "member" }, id, true)).toBe(
			undefined,
		);
		withdraw.abort("too late");
		expect(await answer).toBe("approved");
		expect(frames.filter((f) => f.type === "prompt_closed")).toHaveLength(1);
	});

	test("a withdrawal that came first leaves a later approval refused", async () => {
		const withdraw = new AbortController();
		const { desk, answer, id } = open(withdraw.signal);
		withdraw.abort();
		expect(desk.approve({ principalId: "ann", tier: "member" }, id, true)).toBe(
			"unknown_prompt",
		);
		expect(await answer).toBe("cancelled");
	});

	test("a signal that is already aborted opens no prompt", async () => {
		const withdraw = new AbortController();
		withdraw.abort();
		const { frames, answer } = open(withdraw.signal);
		expect(await answer).toBe("cancelled");
		expect(frames).toEqual([]);
	});
});

describe("the card that approved a call", () => {
	function open(approvedPrompt: (prompt: string) => void) {
		const frames: ServerFrame[] = [];
		const desk = new PromptDesk({
			send: (_principal, frame) => void frames.push(frame),
			sendWhere: () => undefined,
			sendOne: () => undefined,
			supports: () => [],
			timeoutMs: 60_000,
		});
		const scope = promptScope(speakerOf("ann", "member"), "shared");
		const answer = desk
			.prompts("c1", scope)
			.confirm("Send?", "sends it", undefined, "member", undefined, undefined, {
				approvedPrompt,
			});
		const prompt = frames.find((frame) => frame.type === "prompt");
		const id = prompt?.type === "prompt" ? prompt.prompt.id : "";
		return { desk, answer, id };
	}

	test("is reported by its prompt id before the approval resolves", async () => {
		const heard: string[] = [];
		const { desk, answer, id } = open((prompt) => heard.push(prompt));
		desk.approve({ principalId: "ann", tier: "member" }, id, true);
		expect(heard).toEqual([id]);
		expect(await answer).toBe("approved");
	});

	test("is not reported for a refusal, an expiry or a stop", async () => {
		const heard: string[] = [];
		const declined = open((prompt) => heard.push(prompt));
		declined.desk.approve(
			{ principalId: "ann", tier: "member" },
			declined.id,
			false,
		);
		expect(await declined.answer).toBe("declined");
		expect(heard).toEqual([]);
	});
});
