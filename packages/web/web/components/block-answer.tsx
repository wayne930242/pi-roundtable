import {
	type Answer,
	type BlockSegment,
	encodeAnswer,
	inlinePlain,
} from "pi-better-show";
import { PbsBlock } from "pi-better-show/react";
import { useContext, useEffect, useState } from "react";
import type { BlockAnswerBody } from "../../src/api-types.ts";
import { BLOCK_ANSWER_CSS } from "../lib/block-answer-style.ts";
import {
	answerBlock,
	type BlockReply,
	cellKey,
	lockBlock,
	pendBlock,
	reopenBlock,
	settleBlock,
	useBlockCell,
} from "../lib/block-answers.ts";
import { BlockScopeContext } from "../lib/block-scope.ts";
import { installStyle } from "../lib/lazy-style.ts";
import { locale, translate as t } from "../lib/messages.ts";
import { useConnection } from "../lib/socket.ts";
import { useTheme } from "../lib/theme.ts";

/** A question key that is a plain identifier is the agent's own handle for its answer, not words the owner is shown as saying. */
const HANDLE = /^[A-Za-z0-9_.-]{1,40}$/;

const differs = (name: string, label: string | undefined): boolean =>
	inlinePlain(label ?? name) !== name;

/** The blocks that take several values: the answer is final, so the owner sees what goes before it does. */
function severalValues(segment: BlockSegment): boolean {
	if (segment.kind === "checklist") return true;
	if (segment.kind === "review") return segment.data.pick !== undefined;
	return (
		segment.kind === "form" &&
		segment.data.questions.some((one) => one.type === "multi")
	);
}

/**
 * Whether the answer would carry text the owner was not shown as it goes: a picked choice whose
 * value is not its label, a checklist item whose name is not its label, a question key that is not
 * a plain identifier and not its label as drawn, a suggestion whose text is not its label. (A choice not picked may ask once more than it
 * needs; that costs one tap.)
 */
function hidden(segment: BlockSegment, fields: Answer["fields"]): boolean {
	if (segment.kind === "checklist")
		return segment.data.items.some((item) => differs(item.name, item.label));
	if (segment.kind === "suggest")
		return segment.data.items.some(
			(item) =>
				item.text !== inlinePlain(item.label) &&
				fields.some(([, value]) => value === item.text),
		);
	if (segment.kind !== "form") return false;
	return segment.data.questions.some(
		(one) =>
			(differs(one.name, one.label) && !HANDLE.test(one.name)) ||
			one.choices.some(
				(choice) =>
					differs(choice.value, choice.label) &&
					fields.some(
						([name, value]) =>
							name === one.name && value.includes(choice.value),
					),
			),
	);
}

/** The block's title as the agent gave it: the text of the answer names it, and the server writes the same. */
function titleOf(segment: BlockSegment): string | undefined {
	const { title } = segment.data as { title?: unknown };
	return typeof title === "string" ? title : undefined;
}

/** Why an answer did not go, in the page's words. */
function refusal(reply: Extract<BlockReply, { ok: false }>): string {
	switch (reply.code) {
		case "unanswerable":
			return t(
				"This message can no longer be answered here. Type your answer instead.",
			);
		case "invalid":
			return t("Not sent: {reason}", {
				reason: reply.reason ?? t("the answer does not fit this block"),
			});
		case "too_long":
			return t("Not sent: the answer is too long.");
		case "forbidden":
		case "read_only":
		case "unknown_room":
			return t(
				"This room does not take answers here. Type your answer instead.",
			);
		default:
			return t("Not sent. Check the connection, then try again.");
	}
}

/**
 * An interactive block of an agent's reply. An answer is not final until the server has it: the
 * element hands it over, the block shows "Sending…" and goes inert, and the server sends it to the
 * agent as the owner's next message; only then does the block lock with what was sent. A block that
 * several values go into shows the exact text first. Where the block cannot be answered (a live
 * reply, an earlier conversation, a room that takes no message) it is drawn disabled, or locked with
 * the answer it has.
 */
export function AnswerBlock({ segment }: { segment: BlockSegment }) {
	installStyle("block-answer", BLOCK_ANSWER_CSS);
	const connection = useConnection();
	const { resolved } = useTheme();
	// Only a stored reply of an agent has blocks that can be answered or are recorded as answered.
	const held = useContext(BlockScopeContext);
	const scope =
		held?.message.kind === "agent" && held.message.id > 0 ? held : undefined;
	const key = scope ? cellKey(scope, segment.index) : undefined;
	const cell = useBlockCell(key);
	const recorded = scope?.message.answers?.find(
		(one) => one.block === segment.index,
	);
	const locked =
		recorded?.fields ?? (cell?.state === "done" ? cell.fields : undefined);
	const pending = cell?.state === "pending";
	// This page's own lock only bridges to the server's record; from then on the record alone decides, so a cancel that removes it reopens the block.
	const bridging = cell?.state === "done";
	useEffect(() => {
		if (key !== undefined && recorded && bridging) settleBlock(key);
	}, [key, recorded, bridging]);
	const open = scope?.open === true && locked === undefined;
	const [check, setCheck] = useState<
		{ body: BlockAnswerBody; text: string } | undefined
	>();
	const [note, setNote] = useState<string | undefined>();
	// The step goes by itself when the block is answered or on its way from elsewhere.
	useEffect(() => {
		if (!open || pending) setCheck(undefined);
	}, [open, pending]);

	const send = (body: BlockAnswerBody) => {
		if (!scope || key === undefined || !pendBlock(key)) return;
		setCheck(undefined);
		setNote(undefined);
		answerBlock(connection, scope, segment.index, body).then((reply) => {
			if (reply.ok) lockBlock(key, body.fields);
			else if (reply.code === "answered")
				lockBlock(key, reply.fields ?? body.fields);
			else {
				reopenBlock(key);
				setNote(refusal(reply));
			}
		});
	};
	const answered = (answer: Answer): boolean => {
		// The block takes the answer into its own hands: it stays as it is until the server has it.
		if (!open || pending) return false;
		const body: BlockAnswerBody = { kind: answer.kind, fields: answer.fields };
		const title = titleOf(segment);
		const text = encodeAnswer({
			...answer,
			...(title === undefined ? {} : { title }),
			ref: { block: segment.index },
		});
		if (severalValues(segment) || hidden(segment, answer.fields))
			setCheck({ body, text });
		else send(body);
		return false;
	};

	return (
		<div
			className="block-slot block-answer"
			data-state={
				locked ? "answered" : pending ? "pending" : open ? "open" : "readonly"
			}
		>
			<div inert={pending || (!open && locked === undefined) || undefined}>
				<PbsBlock
					segment={segment}
					density="compact"
					scheme={resolved}
					lang={locale()}
					answered={locked}
					onAnswer={answered}
				/>
			</div>
			{check ? (
				<fieldset className="block-confirm">
					<legend className="block-confirm-title">
						{t("This is exactly what will be sent:")}
					</legend>
					<pre className="block-confirm-text">{check.text}</pre>
					<div className="block-confirm-row">
						<button type="button" onClick={() => send(check.body)}>
							{t("Send")}
						</button>
						<button
							type="button"
							className="secondary"
							onClick={() => setCheck(undefined)}
						>
							{t("Back")}
						</button>
					</div>
				</fieldset>
			) : null}
			{pending ? (
				<p className="block-note" role="status">
					{t("Sending…")}
				</p>
			) : note ? (
				<p className="block-note" data-tone="error" role="alert">
					{note}
				</p>
			) : null}
		</div>
	);
}
