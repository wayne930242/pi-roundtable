import { type ReactNode, useEffect, useRef } from "react";
import type { Outcome, Running } from "../lib/batch.ts";
import { translate as t } from "../lib/messages.ts";
import { installSelectStyle } from "../lib/select-style.ts";
import { IDLE_STEPS, type Idle } from "../lib/selection.ts";

installSelectStyle();

/** A real checkbox named by the row it belongs to; `mixed` marks a row chosen only because its knight is. */
export function SelectBox(props: {
	label: string;
	checked: boolean;
	mixed?: boolean;
	disabled?: boolean;
	onChange(): void;
}) {
	const box = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (box.current) box.current.indeterminate = props.mixed === true;
	}, [props.mixed]);
	return (
		<input
			ref={box}
			type="checkbox"
			className="select-box"
			aria-label={props.label}
			checked={props.checked}
			disabled={props.disabled === true}
			onChange={props.onChange}
			// A tap on the box must not also run the row's own toggle.
			onClick={(event) => event.stopPropagation()}
		/>
	);
}

/** "Select all in section", which becomes "Clear selection" once every row the section shows is chosen. */
export function SelectAll(props: {
	selecting: boolean;
	allChosen: boolean;
	empty: boolean;
	onAll(): void;
}) {
	if (!props.selecting || props.empty) return null;
	return (
		<button
			type="button"
			className="secondary compact select-all"
			onClick={props.onAll}
		>
			{props.allChosen ? t("Clear selection") : t("Select all in section")}
		</button>
	);
}

/** A section's heading, with "Select all in section" while the page is selecting. */
export function SectionHead(props: {
	title: ReactNode;
	selecting: boolean;
	/** Every row the section shows is chosen. */
	allChosen: boolean;
	empty: boolean;
	onAll(): void;
}) {
	return (
		<div className="section-head">
			<h2 className="section-title">{props.title}</h2>
			<SelectAll {...props} />
		</div>
	);
}

/** The age filter of a long section: all, idle for 7 days or more, 30 days or more, each with its count. */
export function IdleChips(props: {
	counts: Record<Idle, number>;
	value: Idle;
	onChange(value: Idle): void;
}) {
	const words: Record<Idle, string> = {
		0: t("All"),
		7: t("No activity for 7+ days"),
		30: t("No activity for 30+ days"),
	};
	return (
		<fieldset className="select-chips" aria-label={t("Filter by activity")}>
			{IDLE_STEPS.map((days) => (
				<button
					key={days}
					type="button"
					aria-pressed={props.value === days}
					onClick={() => props.onChange(days)}
				>
					{words[days]} <span className="count">{props.counts[days]}</span>
				</button>
			))}
		</fieldset>
	);
}

/** One action of the bar. */
export interface BarAction {
	id: string;
	label: string;
	tone?: "danger";
	onPress(): void;
}

/**
 * The bar at the foot of a page that is selecting: how many rows are chosen, the actions of the
 * section they are in, the progress of a run and, after it, the rows that were not done. The count is
 * announced politely.
 */
export function SelectBar(props: {
	count: number;
	actions: BarAction[];
	running: Running | undefined;
	outcome: Outcome | undefined;
	onDismiss(): void;
}) {
	const { running, outcome } = props;
	useEffect(() => {
		document.body.dataset.selecting = "";
		return () => {
			delete document.body.dataset.selecting;
		};
	}, []);
	return (
		<div className="select-dock">
			{outcome ? (
				<div className="select-result" role="status">
					<strong>{outcome.summary}</strong>
					<ul>
						{outcome.refused.map((one) => (
							<li key={`${one.name}:${one.reason}`}>
								<strong>{one.name}</strong> — {one.reason}
							</li>
						))}
					</ul>
					<button type="button" className="secondary" onClick={props.onDismiss}>
						{t("Dismiss")}
					</button>
				</div>
			) : null}
			<div
				className="select-bar"
				role="toolbar"
				aria-label={t("Actions on the chosen rows")}
			>
				<span className="select-count" aria-live="polite">
					{running
						? t("{label} {finished} / {total}", {
								label: running.label,
								finished: running.finished,
								total: running.total,
							})
						: t("{count} selected", { count: props.count })}
				</span>
				{props.actions.map((action) => (
					<button
						key={action.id}
						type="button"
						className={action.tone === "danger" ? "danger" : "secondary"}
						disabled={running !== undefined || props.count === 0}
						onClick={action.onPress}
					>
						{action.label}
					</button>
				))}
				{running ? (
					<progress
						max={running.total}
						value={running.finished}
						aria-label={running.label}
					/>
				) : null}
			</div>
		</div>
	);
}
