import type { PromptFrame } from "../../src/api-types.ts";
import { translate as t } from "../lib/messages.ts";
import type { CardState } from "../lib/rooms.ts";
import { Collapse, CopyButton, Shell, useAnswering } from "./cards-shell.tsx";
import { Icon } from "./icons.tsx";
import { MessageMarkdown } from "./message-markdown.tsx";

export function ApprovalCard({
	card,
	timeZone,
	frame,
}: {
	card: CardState;
	timeZone: string;
	frame: Extract<PromptFrame, { kind: "approval" }>;
}) {
	const { sent, send } = useAnswering(card);
	const timeout = frame.purpose === "turn-timeout";
	const answer = (approved: boolean) =>
		send({ type: "approval", prompt: frame.id, approved });
	const { approval } = frame;
	return (
		<Shell
			card={card}
			timeZone={timeZone}
			tone={timeout ? "timeout" : "action"}
			icon={timeout ? "timer" : "shield"}
			title={frame.title}
		>
			<MessageMarkdown source={frame.message} />
			{approval ? (
				<details className="prompt-details">
					<summary>{t("Details")}</summary>
					<dl className="facts">
						<div>
							<dt>{t("Tool")}</dt>
							<dd>{approval.tool}</dd>
						</div>
						<div>
							<dt>{t("Action")}</dt>
							<dd>{approval.action}</dd>
						</div>
					</dl>
					{Object.keys(approval.input).length ? (
						<pre className="prompt-input">
							{JSON.stringify(approval.input, null, 2)}
						</pre>
					) : null}
					{approval.files?.length ? (
						<ul className="prompt-files">
							{approval.files.map((file) => (
								<li key={file.path}>
									<Icon name="file" size={14} />
									<code>{file.path}</code>
									{file.bytes === undefined ? null : (
										<span className="meta">{file.bytes} B</span>
									)}
								</li>
							))}
						</ul>
					) : null}
					{approval.truncated ? (
						<p className="hint">
							{t(
								"Long values are cut here; the action runs with the full text.",
							)}
						</p>
					) : null}
				</details>
			) : null}
			{approval?.copy && !card.outcome ? (
				<CopyButton copy={approval.copy} />
			) : null}
			{frame.speakerOnly ? (
				<p className="hint">
					{t("Only the person this turn answers can approve it.")}
				</p>
			) : null}
			{frame.approvers?.length ? (
				<p className="hint">
					{t("{names} can approve this, and so can an owner.", {
						names: frame.approvers.join(", "),
					})}
				</p>
			) : null}
			{frame.late && !card.outcome ? (
				<p className="hint">
					{t(
						"The turn stopped waiting. Your answer starts a new turn in this room.",
					)}
				</p>
			) : null}
			<Collapse open={!card.outcome}>
				<div className="actions">
					<button
						type="button"
						className="secondary"
						disabled={sent}
						onClick={() => answer(false)}
					>
						{frame.wording?.decline ??
							(timeout ? t("Stop turn") : t("Decline"))}
					</button>
					<button type="button" disabled={sent} onClick={() => answer(true)}>
						{frame.wording?.approve ?? (timeout ? t("Continue") : t("Approve"))}
					</button>
				</div>
				{frame.wording?.footer ? (
					<p className="hint">{frame.wording.footer}</p>
				) : null}
			</Collapse>
		</Shell>
	);
}
