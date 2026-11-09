import { useEffect, useRef, useState } from "react";
import type {
	ClientFrame,
	PromptAnswer,
	PromptOutcome,
} from "../../src/api-types.ts";
import { useRoomAccent } from "../lib/characters.ts";
import { when } from "../lib/format.ts";
import { useLook } from "../lib/look.ts";
import { useMenuPress } from "../lib/menu-press.ts";
import { cardMenuOf } from "../lib/menus.ts";
import { translate as t, wording } from "../lib/messages.ts";
import type { CardState } from "../lib/rooms.ts";
import { useConnection } from "../lib/socket.ts";
import { toast } from "../lib/toast.ts";
import { Icon } from "./icons.tsx";

const OUTCOMES: Record<PromptOutcome, string> = {
	approved: wording("Approved"),
	declined: wording("Declined"),
	answered: wording("Answered"),
	expired: wording("Expired"),
	cancelled: wording("Cancelled"),
	withdrawn: wording("Withdrawn"),
};

/** What the card says after it ended. */
export function outcomeText(card: CardState): string {
	const { frame, outcome } = card;
	if (!outcome) return "";
	if (frame.kind === "approval" && frame.wording) {
		if (outcome === "approved") return frame.wording.approved;
		if (outcome === "declined") return frame.wording.declined;
	}
	const base = t(OUTCOMES[outcome]);
	return card.note ? `${base}: ${card.note}` : base;
}

/**
 * What a card sends and whether it waits for the server. The buttons lock only once the frame
 * was sent; a frame that could not go says so and leaves them as they were, and a refusal of the
 * answer (counted on the card) gives them back.
 */
export function useAnswering(card: CardState) {
	const connection = useConnection();
	const [sent, setSent] = useState(false);
	const refused = card.refused ?? 0;
	useEffect(() => {
		if (refused > 0) setSent(false);
	}, [refused]);
	const send = (frame: ClientFrame): boolean => {
		if (!connection.send(frame)) {
			toast(
				t("Not connected right now. Try again when the connection is back."),
				"danger",
			);
			return false;
		}
		setSent(true);
		return true;
	};
	return { sent, send };
}

/** The answer as the card shows it after it ended: the options picked, then the person's own words. */
export function describeAnswer(answer: PromptAnswer): string {
	const text = answer.text?.trim();
	return [...answer.choices, ...(text ? [text] : [])].join(", ");
}

/** Shows or hides the card's buttons with a height change that follows the card's end. */
export function Collapse({
	open,
	children,
}: {
	open: boolean;
	children: React.ReactNode;
}) {
	return (
		<div className="collapse" data-open={open}>
			<div className="collapse-inner" inert={!open}>
				{children}
			</div>
		</div>
	);
}

/**
 * The wax seal an approved approval card keeps under the Camelot look: in the room agent's
 * accent, with the agent's own mark pressed into it. It is stamped in (`stamp`) only when the card
 * turns approved while the page shows it; a card the room shows already approved keeps the seal
 * still. The card says "Approved" in words, so the seal is decoration.
 */
export function WaxSeal({ room, stamp }: { room: string; stamp: boolean }) {
	const accent = useRoomAccent(room);
	return (
		<span
			className="wax-seal"
			data-stamp={stamp ? "true" : undefined}
			style={accent}
			aria-hidden="true"
		>
			<svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">
				<path
					className="seal-body"
					d="M37.4 21.9Q36.3 23.7 36.6 25.9Q37.0 28.2 35.0 29.3Q33.0 30.4 32.4 32.5Q31.7 34.6 29.5 34.9Q27.3 35.2 25.7 36.6Q24.1 37.9 22.0 37.4Q20.0 37.0 18.0 37.4Q15.9 37.9 14.3 36.6Q12.6 35.3 10.6 34.8Q8.6 34.4 7.8 32.4Q7.0 30.4 5.1 29.2Q3.2 28.1 3.2 26.0Q3.2 23.8 2.4 21.9Q1.6 20.0 2.6 18.1Q3.6 16.3 3.4 14.1Q3.1 11.8 4.7 10.5Q6.4 9.2 7.4 7.3Q8.3 5.3 10.5 5.0Q12.7 4.8 14.2 3.1Q15.8 1.4 17.9 2.4Q20.0 3.4 22.1 2.4Q24.2 1.5 25.8 3.2Q27.3 4.8 29.4 5.2Q31.5 5.6 32.3 7.6Q33.1 9.6 34.9 10.8Q36.7 12.0 36.8 14.1Q36.8 16.2 37.7 18.1Q38.6 20.0 37.4 21.9Z"
				/>
				<circle className="seal-ring" cx="20" cy="20" r="12.5" />
				<path className="seal-mark" d="M13.5 20.5l4.6 4.6 8.6-9.6" />
			</svg>
		</span>
	);
}

export function Shell(props: {
	card: CardState;
	timeZone: string;
	tone: "action" | "timeout" | "ask";
	icon: "shield" | "timer" | "sparkle";
	title: string;
	children: React.ReactNode;
}) {
	const { card } = props;
	const late = "late" in card.frame && card.frame.late;
	const { timeZone } = props;
	const ended = [
		card.by,
		card.closedAt ? when(card.closedAt, timeZone) : undefined,
	].filter(Boolean);
	const sealed =
		useLook() === "camelot" &&
		card.frame.kind === "approval" &&
		card.outcome === "approved";
	// Whether the card was approved already when this one mounted (a room entered again, a pane switched back to).
	const approvedOnMount = useRef(card.outcome === "approved");
	const press = useMenuPress(() => cardMenuOf(card.frame));
	return (
		<article
			{...press}
			className={`prompt prompt-${props.tone}`}
			data-ended={card.outcome ? "true" : undefined}
			data-sealed={sealed ? "true" : undefined}
			aria-label={props.title}
		>
			<header className="prompt-head">
				<span className="prompt-icon">
					<Icon name={props.icon} size={18} />
				</span>
				<strong>{props.title}</strong>
				{late && !card.outcome ? (
					<span className="badge badge-warn">{t("Late")}</span>
				) : null}
				{card.outcome ? (
					<span className="prompt-outcome" data-outcome={card.outcome}>
						<Icon
							name={
								card.outcome === "approved" || card.outcome === "answered"
									? "check"
									: "close"
							}
							size={14}
						/>
						{outcomeText(card)}
					</span>
				) : null}
			</header>
			{card.outcome && ended.length > 0 ? (
				<p className="prompt-meta">{ended.join(" · ")}</p>
			) : null}
			{props.children}
			{sealed ? (
				<WaxSeal room={card.room} stamp={!approvedOnMount.current} />
			) : null}
		</article>
	);
}

export function CopyButton({
	copy,
}: {
	copy: { label?: string | undefined; text: string };
}) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			className="secondary copy-action"
			onClick={() => {
				navigator.clipboard
					?.writeText(copy.text)
					.then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1400);
					})
					.catch(() => undefined);
			}}
		>
			<Icon name={copied ? "check" : "copy"} size={16} />
			{copied
				? t("Copied")
				: copy.label
					? t("Copy {label}", { label: copy.label })
					: t("Copy")}
		</button>
	);
}
