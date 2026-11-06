import { useEffect, useRef } from "react";
import type { AgentProfileView } from "../../src/api-types.ts";
import { translate as t } from "../lib/messages.ts";
import {
	DEFAULT,
	type FieldsDraft as Draft,
	thinkingOf,
} from "./agent-fields.tsx";
import { TextDiff } from "./diff-block.tsx";

/** The select's "no model chosen" row: the resolved model when this page knows it, else the server setting. */
export const defaultModelLabel = (profile: AgentProfileView) =>
	profile.model === undefined
		? t("Default model ({current})", { current: profile.effective.model })
		: t("Default model (server setting)");

/** What a save would change, read over once: the changed fields, and the prompt line by line. */
export function Review(props: {
	profile: AgentProfileView;
	draft: Draft;
	saving: boolean;
	onBack(): void;
	onSave(): void;
}) {
	const { profile, draft } = props;
	const root = useRef<HTMLElement>(null);
	// The form's button that opened the review is gone; the keyboard continues from the review.
	useEffect(() => root.current?.focus(), []);
	const changes: { label: string; before: string; after: string }[] = [];
	if (draft.displayName !== profile.displayName)
		changes.push({
			label: t("Name"),
			before: profile.displayName,
			after: draft.displayName,
		});
	const modelOf = (value: string) =>
		value === DEFAULT ? defaultModelLabel(profile) : value;
	if (draft.model !== (profile.model ?? DEFAULT))
		changes.push({
			label: t("Model"),
			before: modelOf(profile.model ?? DEFAULT),
			after: modelOf(draft.model),
		});
	if (draft.thinking !== (profile.thinking ?? DEFAULT))
		changes.push({
			label: t("Thinking level"),
			before: thinkingOf(profile.thinking ?? DEFAULT),
			after: thinkingOf(draft.thinking),
		});
	return (
		<section
			ref={root}
			className="stack review"
			tabIndex={-1}
			aria-label={t("Review changes")}
		>
			<h3>{t("Review changes")}</h3>
			{changes.length ? (
				<ul className="review-fields">
					{changes.map((change) => (
						<li key={change.label}>
							<strong>{change.label}</strong>
							<span className="review-before">{change.before}</span>
							<span aria-hidden="true">→</span>
							<span className="review-after">{change.after}</span>
						</li>
					))}
				</ul>
			) : null}
			<TextDiff
				label={t("Prompt")}
				before={profile.prompt}
				after={draft.prompt}
			/>
			<div className="actions">
				<button
					type="button"
					className="secondary"
					disabled={props.saving}
					onClick={props.onBack}
				>
					{t("Back to editing")}
				</button>
				<button type="button" disabled={props.saving} onClick={props.onSave}>
					{props.saving ? t("Saving…") : t("Save")}
				</button>
			</div>
		</section>
	);
}
