import { beforeAll, describe, expect, test } from "bun:test";
import type { ToolTurn } from "../../define.ts";
import { type HoldCheck, type HoldRule, holdChain } from "../../holds.ts";
import { SYSTEM_PRINCIPAL } from "../../identity/principal-store.ts";
import type {
	Approval,
	ApprovedBy,
	Prompts,
} from "../../interactions/prompts.ts";
import type {
	AutoApproval,
	ConversationMode,
} from "../../modes/conversation-modes.ts";
import { shellHoldRule } from "../../modules/host-shell/shell-policy.ts";
import type { ChannelKey } from "../../sessions.ts";
import type { Speaker } from "../../speakers.ts";
import { useTestLocale } from "../../testing/locale.ts";
import { TEST_OWNER as OWNER, OWNER_SPEAKER } from "../../testing/owner.ts";
import { MAIL, MAIL_RULE } from "./confirmation-fixture.ts";
import { ConfirmationGate } from "./confirmation-gate.ts";
import { yoloApprover } from "./yolo.ts";

useTestLocale();
beforeAll(() => useTestLocale());

const ROOM = "app:agent.guide" as ChannelKey;
const CONTEXT = { workspace: "/work", scratchDir: "/work/scratch" };
const turn = { speaker: OWNER_SPEAKER } as unknown as ToolTurn;
const inTurn = { toolTurn: () => turn };

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

/** A card that records each ask and answers `answer`. */
function cards(answer: Approval = "declined") {
	let asked = 0;
	const prompts: Prompts = {
		confirm: async () => {
			asked++;
			return answer;
		},
		ask: async () => undefined,
	};
	return {
		prompts,
		get asked() {
			return asked;
		},
	};
}

interface Setup {
	holds?: HoldCheck;
	yolo?: boolean;
	speaker?: Speaker;
	autonomy?: { allow?: string[]; card?: string[] };
}

/** A gate on a yolo room with a bash tool, its turn begun by `speaker`. */
function room(setup: Setup = {}) {
	const mode = modes(setup.yolo ?? true);
	const speaker = setup.speaker ?? OWNER_SPEAKER;
	const gate = new ConfirmationGate(
		setup.holds ?? holdChain([shellHoldRule, MAIL_RULE]),
		OWNER,
		undefined,
		CONTEXT,
	);
	gate.beginTurn(
		"s",
		false,
		undefined,
		speaker,
		false,
		yoloApprover({
			modes: mode,
			autonomy: {
				yolo: {
					allow: setup.autonomy?.allow ?? [],
					card: setup.autonomy?.card ?? [],
				},
			},
			channel: ROOM,
			speaker,
		}),
	);
	return { gate, mode };
}

const bash = (gate: ConfirmationGate, command: string, card = cards()) =>
	gate
		.decide(
			"bash",
			{ command },
			{ prompts: card.prompts, asker: "guide" },
			inTurn,
		)
		.then((result) => ({ result, card }));

describe("yolo approves a held call without a card", () => {
	test("a plain git push is approved by yolo, with no card, and reported to the modes", async () => {
		const { gate, mode } = room();
		const { result, card } = await bash(gate, "git push origin main");
		expect(result.reason).toBeUndefined();
		expect(result.approvedBy).toEqual({
			principalId: OWNER_SPEAKER.principalId,
			speakerId: OWNER_SPEAKER.id,
			name: OWNER_SPEAKER.name,
			owner: true,
			auto: "yolo",
		} satisfies ApprovedBy);
		expect(result.approvedPrompt).toBeUndefined();
		expect(result.approvedOnCard).toBeUndefined();
		expect(card.asked).toBe(0);
		expect(mode.approvals).toHaveLength(1);
		expect(mode.approvals[0]).toMatchObject({
			channel: ROOM,
			tool: "bash",
			classes: ["shell.push"],
			principalId: OWNER_SPEAKER.principalId,
		});
		expect(mode.approvals[0]?.action).toContain("git push origin main");
		expect(mode.approvals[0]?.at).toBeInstanceOf(Date);
	});

	test("a write outside the workspace is approved, in a shell line and by the write tool", async () => {
		const { gate, mode } = room();
		expect((await bash(gate, "echo x > /etc/f")).result.approvedBy?.auto).toBe(
			"yolo",
		);
		const written = await gate.decide(
			"write",
			{ path: "/etc/f", content: "x" },
			{ prompts: cards().prompts, asker: "guide" },
			inTurn,
		);
		expect(written.approvedBy?.auto).toBe("yolo");
		expect(mode.approvals.map((a) => a.classes)).toEqual([
			["shell.write"],
			["shell.write"],
		]);
	});

	test("a call a rule holds without classes is classed by the rule's name, and approved", async () => {
		const { gate, mode } = room();
		const result = await gate.decide(
			MAIL,
			{ to: "a@b.c" },
			{ prompts: cards().prompts, asker: "guide" },
			inTurn,
		);
		expect(result.approvedBy?.auto).toBe("yolo");
		expect(mode.approvals[0]?.classes).toEqual(["mail"]);
	});

	test("it approves with no card surface at all, as a turn that cannot ask", async () => {
		const { gate } = room();
		const result = await gate.decide(
			"bash",
			{ command: "git push origin main" },
			undefined,
			inTurn,
		);
		expect(result.reason).toBeUndefined();
		expect(result.approvedBy?.auto).toBe("yolo");
	});

	test("a call decided outside a turn is classed by its rule too", async () => {
		const { gate } = room();
		const result = await gate.decide("bash", {
			command: "git push origin main",
		});
		expect(result.approvedBy?.auto).toBe("yolo");
	});

	test("a class the config allows is approved", async () => {
		const { gate } = room({ autonomy: { allow: ["shell.privilege"] } });
		expect((await bash(gate, "sudo ls")).result.approvedBy?.auto).toBe("yolo");
	});
});

describe("yolo still asks on a card", () => {
	const carded = async (setup: Setup, command = "git push origin main") => {
		const { gate, mode } = room(setup);
		const { result, card } = await bash(gate, command);
		expect(mode.approvals).toEqual([]);
		expect(result.approvedBy).toBeUndefined();
		expect(card.asked).toBe(1);
		return result;
	};

	test("yolo is off", async () => {
		await carded({ yolo: false });
	});

	test("a destructive class: sudo, rm, force push, reset --hard, gh, docker", async () => {
		for (const command of [
			"sudo ls",
			"rm -rf /var/x",
			"git push --force origin main",
			"git reset --hard HEAD~1",
			"gh pr merge 3",
			"docker rm web",
			"systemctl restart nginx",
			"kill -9 1",
		])
			await carded({}, command);
	});

	test("a harmless class beside a destructive one in the same line", async () => {
		await carded({}, "echo x > /etc/f; sudo ls");
		await carded({}, `bash -c "echo x > /etc/f; rm -rf /x"`);
		await carded({}, "git push origin main && sudo reboot");
	});

	test("a class the config cards, or whose rule it cards", async () => {
		await carded({ autonomy: { card: ["shell.push"] } });
		await carded({ autonomy: { card: ["shell"] } });
		await carded({ autonomy: { card: ["shell.write"] } }, "echo x > /etc/f");
	});

	test("a rule without classes of its own is carded by its name", async () => {
		const { gate, mode } = room({ autonomy: { card: ["mail"] } });
		const card = cards();
		const result = await gate.decide(
			MAIL,
			{ to: "a@b.c" },
			{ prompts: card.prompts, asker: "guide" },
			inTurn,
		);
		expect(mode.approvals).toEqual([]);
		expect(result.approvedBy).toBeUndefined();
		expect(card.asked).toBe(1);
	});

	test("a class that is both allowed and carded stays carded", async () => {
		await carded(
			{ autonomy: { allow: ["shell.privilege"], card: ["shell.privilege"] } },
			"sudo ls",
		);
	});

	test("a speaker below the owner", async () => {
		await carded({ speaker: { ...OWNER_SPEAKER, tier: "member" } });
	});

	test("the host's own principal, which the webhook and report turns speak as", async () => {
		await carded({
			speaker: { ...OWNER_SPEAKER, principalId: SYSTEM_PRINCIPAL },
		});
	});

	test("a rule that names approvers", async () => {
		const named: HoldRule = {
			name: "named",
			describe: () => undefined,
			describeInTurn: (tool) => (tool === "bash" ? "run it" : undefined),
			approversInTurn: () => ["p-someone"],
		};
		const { gate, mode } = room({ holds: holdChain([named]) });
		const { result, card } = await bash(gate, "ls");
		expect(mode.approvals).toEqual([]);
		expect(result.approvedBy).toBeUndefined();
		expect(card.asked).toBe(1);
	});

	test("a card that is the speaker's alone", async () => {
		const solo: HoldRule = {
			name: "solo",
			describe: () => undefined,
			describeInTurn: (tool) =>
				tool === "bash" ? { text: "run it", approval: "speaker" } : undefined,
		};
		const { gate, mode } = room({ holds: holdChain([solo]) });
		const { result, card } = await bash(gate, "ls");
		expect(mode.approvals).toEqual([]);
		expect(result.approvedBy).toBeUndefined();
		expect(card.asked).toBe(1);
	});

	test("a hold that carries no classes", async () => {
		// A check made without holdChain has no classes for its calls: unknown, so carded.
		const bare: HoldCheck = Object.assign(
			(tool: string) => (tool === "bash" ? "run it" : undefined),
			{
				inTurn: (tool: string) => (tool === "bash" ? "run it" : undefined),
			},
		);
		const { gate, mode } = room({ holds: bare });
		const { result, card } = await bash(gate, "ls");
		expect(mode.approvals).toEqual([]);
		expect(result.approvedBy).toBeUndefined();
		expect(card.asked).toBe(1);
	});

	test("a hold that lookup waits for does not skip the classes of its rule", async () => {
		const slow: HoldRule = {
			name: "slow",
			describe: () => undefined,
			describeInTurn: async (tool) => (tool === "bash" ? "run it" : undefined),
			holdClasses: () => ["slow.danger"],
		};
		const { gate, mode } = room({
			holds: holdChain([slow]),
			autonomy: { card: ["slow.danger"] },
		});
		const { result, card } = await bash(gate, "ls");
		expect(mode.approvals).toEqual([]);
		expect(result.approvedBy).toBeUndefined();
		expect(card.asked).toBe(1);
	});

	test("without yolo and without a card surface the call is held for a message, as before", async () => {
		const { gate } = room({ yolo: false });
		const result = await gate.decide(
			"bash",
			{ command: "git push origin main" },
			undefined,
			inTurn,
		);
		expect(result.reason).toContain("git push origin main");
		expect(result.refused).toBe("held");
		expect(result.approvedBy).toBeUndefined();
	});
});

describe("yolo reads the mode when the call is made", () => {
	test("a call before the toggle is carded and a call after it is approved", async () => {
		const { gate, mode } = room({ yolo: false });
		const first = await bash(gate, "git push origin main");
		expect(first.card.asked).toBe(1);
		mode.state.yolo = true;
		const second = await bash(gate, "git push origin main");
		expect(second.card.asked).toBe(0);
		expect(second.result.approvedBy?.auto).toBe("yolo");
		mode.state.yolo = false;
		expect((await bash(gate, "git push origin main")).card.asked).toBe(1);
	});

	test("a card opened before the toggle stays for a person to answer", async () => {
		const { gate, mode } = room({ yolo: false });
		const answer = Promise.withResolvers<Approval>();
		let asked = 0;
		const prompts: Prompts = {
			confirm: () => {
				asked++;
				return answer.promise;
			},
			ask: async () => undefined,
		};
		const open = gate.decide(
			"bash",
			{ command: "git push origin main" },
			{ prompts, asker: "guide" },
			inTurn,
		);
		await Bun.sleep(10);
		mode.state.yolo = true;
		answer.resolve("declined");
		const result = await open;
		expect(asked).toBe(1);
		expect(result.refused).toBe("declined");
		expect(mode.approvals).toEqual([]);
	});
});

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
