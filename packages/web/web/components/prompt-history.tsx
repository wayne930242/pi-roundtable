import { useEffect, useState } from "react";
import { messageOf } from "../lib/api.ts";
import { useConfig } from "../lib/config.ts";
import { when } from "../lib/format.ts";
import { translate as t } from "../lib/messages.ts";
import { TextDiff } from "./diff-block.tsx";
import { Sheet } from "./sheet.tsx";
import { Badge, Empty, Failure, Loading } from "./states.tsx";

/** One saved version of a text, as the history lists it. */
export interface HistoryItem {
	id: number;
	/** The text this version put in force. */
	text: string;
	/** The text it replaced. */
	previous: string;
	by: string;
	/** ISO time. */
	at: string;
	/** The change went back to the file version. */
	revert?: boolean;
}

/**
 * The versions of a text, newest first: who changed it, when, and what the change did as a diff.
 * A version's text can be taken into the editor, where it is read over and saved like any edit; the
 * history itself changes nothing.
 */
export function HistorySheet(props: {
	open: boolean;
	title: string;
	load(): Promise<HistoryItem[]>;
	onUse(text: string): void;
	onClose(): void;
}) {
	const { open, load } = props;
	const { timeZone } = useConfig();
	const [items, setItems] = useState<HistoryItem[]>();
	const [error, setError] = useState<string>();
	const [chosen, setChosen] = useState<number>();
	// biome-ignore lint/correctness/useExhaustiveDependencies: each open reads the history again
	useEffect(() => {
		if (!open) return;
		let current = true;
		setItems(undefined);
		setError(undefined);
		setChosen(undefined);
		load().then(
			(loaded) => current && setItems(loaded),
			(failure) => current && setError(messageOf(failure)),
		);
		return () => {
			current = false;
		};
	}, [open]);
	const shown = items?.find((item) => item.id === chosen);
	return (
		<Sheet open={open} title={props.title} size="wide" onClose={props.onClose}>
			<div className="stack history">
				{error ? <Failure message={error} /> : null}
				{!items && !error ? <Loading /> : null}
				{items?.length === 0 ? (
					<Empty>{t("No changes have been kept yet.")}</Empty>
				) : null}
				{items && items.length > 0 ? (
					<ul className="menu">
						{items.map((item) => (
							<li key={item.id}>
								<button
									type="button"
									className="menu-item"
									aria-pressed={item.id === chosen}
									onClick={() => setChosen(item.id)}
								>
									<span className="menu-text">
										<strong>{item.by}</strong>
										<span className="meta">{when(item.at, timeZone)}</span>
									</span>
									{item.revert ? (
										<Badge>{t("Back to the file version")}</Badge>
									) : null}
								</button>
							</li>
						))}
					</ul>
				) : null}
				{shown ? (
					<section className="stack" aria-label={t("This change")}>
						<TextDiff
							label={t("This change")}
							before={shown.previous}
							after={shown.text}
						/>
						<p className="meta">
							{t(
								"It goes into the editor, where you read it over and save it to put it in force.",
							)}
						</p>
						<div className="actions">
							<button type="button" onClick={() => props.onUse(shown.text)}>
								{t("Use this text")}
							</button>
						</div>
					</section>
				) : null}
			</div>
		</Sheet>
	);
}
