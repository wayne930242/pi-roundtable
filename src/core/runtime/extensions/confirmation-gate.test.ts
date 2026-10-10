import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdChain } from "../../holds.ts";
import type {
	Approval,
	Prompts,
	PromptWait,
} from "../../interactions/prompts.ts";
import { shellHoldRule } from "../../modules/host-shell/shell-policy.ts";
import { TEST_OWNER as OWNER } from "../../testing/owner.ts";
import { MAIL, MAIL_RULE } from "./confirmation-fixture.ts";
import {
	approvalCard,
	CONFIRMATION_TTL_MS,
	ConfirmationGate,
	canonicalJson,
	confirmedTurnText,
} from "./confirmation-gate.ts";

/** Neutral rules: the mail tool waits for the owner, and a session with a workspace has a shell. */
const holds = holdChain([MAIL_RULE, shellHoldRule]);

describe("ConfirmationGate", () => {
	const send = { to: "a@b.c", subject: "hi" };

	test("holds a call and remembers it for the next message", () => {
		const gate = new ConfirmationGate(holds, OWNER);
		gate.beginTurn("workspace", false);
		expect(gate.hold(MAIL, send)).toContain("Held");
		gate.endTurn();
		expect(gate.pending()).toMatchObject({
			selectionId: "workspace",
			calls: [{ tool: MAIL }],
		});
	});

	test("a held call carries the selection id of the turn that held it", () => {
		const gate = new ConfirmationGate(holds, OWNER);
		gate.beginTurn("notes", false);
		gate.hold(MAIL, send);
		gate.endTurn();
		expect(gate.pending()?.selectionId).toBe("notes");
		// The next turn starts afresh: its own id is stamped on what it holds.
		gate.beginTurn("research", false);
		gate.hold(MAIL, send);
		expect(gate.pending()?.selectionId).toBe("research");
	});

	test("a held call carries the speaker of the turn that held it and their principal, or none", () => {
		const gate = new ConfirmationGate(holds, OWNER);
		gate.beginTurn("notes", false, undefined, { id: "7", principalId: "p_7" });
		gate.hold(MAIL, send);
		gate.endTurn();
		expect(gate.pending()?.speakerId).toBe("7");
		expect(gate.pending()?.principalId).toBe("p_7");
		gate.beginTurn("notes", false);
		gate.hold(MAIL, send);
		expect(gate.pending()).not.toHaveProperty("speakerId");
		expect(gate.pending()).not.toHaveProperty("principalId");
	});

	test("a call held outside a turn throws instead of taking a default selection", () => {
		const gate = new ConfirmationGate(holds, OWNER);
		expect(() => gate.hold(MAIL, send)).toThrow(
			"a call was held outside a turn",
		);
		expect(gate.pending()).toBeUndefined();
	});

	test("a confirmed turn releases only the identical call, once", () => {
		const gate = new ConfirmationGate(holds, OWNER);
		gate.beginTurn("workspace", false);
		gate.hold(MAIL, send);
		gate.endTurn();

		gate.beginTurn("workspace", true);
		expect(gate.pending()).toBeUndefined();
		// Key order does not matter; the recipient does.
		expect(gate.hold(MAIL, { subject: "hi", to: "a@b.c" })).toBeUndefined();
		expect(gate.hold(MAIL, { to: "other@b.c", subject: "hi" })).toContain(
			"Held",
		);
		// The approval is spent, so the same call again waits anew.
		expect(gate.hold(MAIL, send)).toContain("Held");
		gate.endTurn();
	});

	test("an unconfirmed next message drops the held actions", () => {
		const gate = new ConfirmationGate(holds, OWNER);
		gate.beginTurn("workspace", false);
		gate.hold(MAIL, send);
		gate.endTurn();
		gate.beginTurn("general", false);
		expect(gate.pending()).toBeUndefined();
		expect(gate.hold(MAIL, send)).toContain("Held");
	});

	test("actions restored from the store expire after a day", () => {
		const held = {
			selectionId: "workspace" as const,
			heldAt: new Date(Date.now() - CONFIRMATION_TTL_MS - 1),
			calls: [
				{
					tool: MAIL,
					input: canonicalJson(send),
					action: "send an email",
				},
			],
		};
		expect(new ConfirmationGate(holds, OWNER, held).pending()).toBeUndefined();
		const fresh = new ConfirmationGate(holds, OWNER, {
			...held,
			heldAt: new Date(),
		});
		expect(fresh.pending()?.calls).toHaveLength(1);
		fresh.beginTurn("workspace", true);
		expect(fresh.hold(MAIL, send)).toBeUndefined();
	});

	test("canonical json sorts keys at every level", () => {
		expect(canonicalJson({ b: 1, a: { d: 2, c: [{ f: 3, e: 4 }] } })).toBe(
			canonicalJson({ a: { c: [{ e: 4, f: 3 }], d: 2 }, b: 1 }),
		);
	});
});

test("a confirmed turn names each released call with its exact input", () => {
	const text = confirmedTurnText(
		{
			selectionId: "discord",
			heldAt: new Date(0),
			calls: [
				{
					tool: "pin_message",
					input: '{"channelId":"2","messageId":"9"}',
					action: "pin message 9 in channel 2",
				},
			],
		},
		"Yes, pin it",
		OWNER,
	);
	expect(text).toContain(
		'- pin message 9 in channel 2: pin_message {"channelId":"2","messageId":"9"}',
	);
	expect(text.endsWith("\n\nYes, pin it")).toBe(true);
});

describe("ConfirmationGate with a workspace", () => {
	const WORKSPACE = "/srv/agents/work";

	test("holds a destructive command and releases it once approved", () => {
		const gate = new ConfirmationGate(holds, OWNER, undefined, {
			workspace: WORKSPACE,
		});
		gate.beginTurn("agent", false);
		expect(gate.hold("bash", { command: "docker restart x" })).toBeString();
		expect(gate.hold("bash", { command: "docker ps" })).toBeUndefined();
		gate.endTurn();
		gate.beginTurn("agent", true);
		expect(gate.hold("bash", { command: "docker restart x" })).toBeUndefined();
	});

	test("a gate without a workspace does not judge shell tools", () => {
		const gate = new ConfirmationGate(holds, OWNER);
		gate.beginTurn("general", false);
		expect(gate.hold("bash", { command: "rm x" })).toBeUndefined();
	});
});

test("an approval card names a file sent by path with its size, not its bytes", () => {
	const dir = mkdtempSync(join(tmpdir(), "approval-card-"));
	const path = join(dir, "sigil.png");
	writeFileSync(path, new Uint8Array(2048));
	const card = approvalCard(
		{
			tool: "discord_send_message",
			input: canonicalJson({ channelId: "1", files: [{ path }] }),
			action: "send a message in #general",
		},
		dir,
	);
	expect(card).toContain(`File \`${path}\` (2.0 KiB)`);
	expect(card).not.toContain("AAAA");
	expect(
		approvalCard(
			{
				tool: "discord_send_message",
				input: canonicalJson({ channelId: "1", files: [{ path: "gone.png" }] }),
				action: "send",
			},
			dir,
		),
	).toContain("File `gone.png` (not found now)");
	rmSync(dir, { recursive: true, force: true });
});

describe("ConfirmationGate with a card that outlives its turn", () => {
	const send = { to: "a@b.c", subject: "hi" };
	/** Cards that answer `answer` and keep each wait they were given. */
	function cards(answer: Approval) {
		const waits: PromptWait[] = [];
		const prompts: Prompts = {
			confirm: async (_title, _message, _signal, _tier, wait) => {
				if (wait) waits.push(wait);
				return answer;
			},
			ask: async () => undefined,
		};
		return { waits, ask: { prompts, asker: "infra" } };
	}

	test("a card resolves a relative file path from the session's directory", async () => {
		const dir = mkdtempSync(join(tmpdir(), "approval-root-"));
		writeFileSync(join(dir, "sigil.png"), new Uint8Array(2048));
		const gate = new ConfirmationGate(
			holds,
			OWNER,
			undefined,
			{},
			undefined,
			dir,
		);
		gate.beginTurn("workspace", false);
		let card = "";
		const prompts: Prompts = {
			confirm: async (_title, message) => {
				card = message;
				return "approved";
			},
			ask: async () => undefined,
		};
		await gate.decide(
			MAIL,
			{ ...send, files: [{ path: "sigil.png" }] },
			{ prompts, asker: "infra" },
		);
		expect(card).toContain("File `sigil.png` (2.0 KiB)");
		rmSync(dir, { recursive: true, force: true });
	});

	test("an unanswered card blocks the call, holds nothing, and tells the model to end its turn waiting", async () => {
		const gate = new ConfirmationGate(holds, OWNER);
		gate.beginTurn("workspace", false);
		const { ask } = cards("pending");
		const { reason } = await gate.decide(MAIL, send, ask);
		expect(reason).toContain("Awaiting Riley's approval");
		expect(reason).toContain("End your turn now");
		expect(reason).not.toContain("30");
		expect(gate.pending()).toBeUndefined();
	});

	test("a late approval releases exactly that call, once, in a later turn", async () => {
		const gate = new ConfirmationGate(holds, OWNER);
		gate.beginTurn("workspace", false);
		const { waits, ask } = cards("pending");
		await gate.decide(MAIL, send, ask);
		gate.endTurn();
		const text = waits[0]?.late({
			kind: "approval",
			approved: true,
			by: "Riley",
		});
		expect(text).toContain("Riley approved");
		expect(text).toContain(`${MAIL} ${canonicalJson(send)}`);
		gate.beginTurn("workspace", false);
		expect(gate.hold(MAIL, { ...send, subject: "other" })).toContain("Held");
		expect(gate.hold(MAIL, send)).toBeUndefined();
		expect(gate.hold(MAIL, send)).toContain("Held");
	});

	test("a late refusal releases nothing and says so", async () => {
		const gate = new ConfirmationGate(holds, OWNER);
		gate.beginTurn("workspace", false);
		const { waits, ask } = cards("pending");
		await gate.decide(MAIL, send, ask);
		const text = waits[0]?.late({
			kind: "approval",
			approved: false,
			by: "Riley",
		});
		expect(text).toContain("Riley declined");
		gate.beginTurn("workspace", false);
		expect(gate.hold(MAIL, send)).toContain("Held");
	});
});
