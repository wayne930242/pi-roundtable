import { describe, expect, test } from "bun:test";
import type { ChannelKey } from "../../domain/sessions.ts";
import type { Speaker } from "../../identity/speakers.ts";
import type {
	AutoApproval,
	ConversationMode,
} from "../../modes/conversation-modes.ts";
import { OWNER_SPEAKER } from "../../testing/owner.ts";
import { yoloApprover } from "./yolo.ts";

const ROOM = "app:agent.guide" as ChannelKey;

/** The modes the approver reads, switched by hand, recording each approval it reports. */
function modes(yolo = true) {
	const state: ConversationMode = { yolo, longRunning: false };
	const approvals: AutoApproval[] = [];
	return {
		state,
		approvals,
		peek: (channel: ChannelKey) => {
			expect(channel).toBe(ROOM);
			return state;
		},
		autoApproved: (entry: AutoApproval) => void approvals.push(entry),
	};
}

describe("yoloApprover", () => {
	const approver = (speaker: Speaker = OWNER_SPEAKER) =>
		yoloApprover({
			modes: modes(),
			autonomy: { yolo: { allow: [], card: [] } },
			channel: ROOM,
			speaker,
		});
	const call = (holdClasses?: string[]) => ({
		tool: "bash",
		input: "{}",
		action: "run it",
		...(holdClasses ? { holdClasses } : {}),
	});

	test("answers for classes it allows only", () => {
		expect(approver()(call(["shell.push"]), { speakerOnly: false })?.auto).toBe(
			"yolo",
		);
		expect(
			approver()(call(["shell.rm"]), { speakerOnly: false }),
		).toBeUndefined();
	});

	test("a call without classes, or with none, is unknown and never answered", () => {
		expect(approver()(call(), { speakerOnly: false })).toBeUndefined();
		expect(approver()(call([]), { speakerOnly: false })).toBeUndefined();
	});

	test("a bare rule name is unclassed: answered only when the config allows the rule", () => {
		expect(approver()(call(["mc"]), { speakerOnly: false })).toBeUndefined();
		const allowing = yoloApprover({
			modes: modes(),
			autonomy: { yolo: { allow: ["mc"], card: [] } },
			channel: ROOM,
			speaker: OWNER_SPEAKER,
		});
		expect(allowing(call(["mc"]), { speakerOnly: false })?.auto).toBe("yolo");
		expect(
			allowing(call(["mc", "shell.rm"]), { speakerOnly: false }),
		).toBeUndefined();
	});

	test("a call that names approvers is never answered", () => {
		expect(
			approver()(
				{ ...call(["shell.push"]), approverIds: ["p-someone"] },
				{ speakerOnly: false },
			),
		).toBeUndefined();
	});

	test("a speaker's alone card is never answered", () => {
		expect(
			approver()(call(["shell.push"]), { speakerOnly: true }),
		).toBeUndefined();
	});
});
