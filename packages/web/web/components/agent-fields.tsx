import { type ReactNode, useId, useState } from "react";
import { translate as t, wording } from "../lib/messages.ts";
import { Chips } from "./chips.tsx";
import { Select, TextArea, TextField } from "./fields.tsx";
import { Icon } from "./icons.tsx";
import { Sheet } from "./sheet.tsx";

/** The value of a model or thinking level not chosen: the agent follows the assistant's, a preset its knight's. */
export const DEFAULT = "default";

/** A knight's permanent name and a preset's: lowercase letters, digits and dashes, 1 to 32. */
export const NAME = /^[a-z0-9-]{1,32}$/;

/** What a thinking setting may be. `default` follows the assistant's, which is automatic. */
const THINKING = [
	DEFAULT,
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;
const THINKING_LABELS: Record<(typeof THINKING)[number], string> = {
	default: wording("Default"),
	off: wording("Off"),
	minimal: wording("Minimal"),
	low: wording("Low"),
	medium: wording("Medium"),
	high: wording("High"),
	xhigh: wording("Very high"),
};
/** The resolved level a profile shows: a setting, or `auto` when the model picks. */
const AUTOMATIC = wording("Automatic");
export const thinkingOf = (value: string) =>
	value === "auto"
		? t(AUTOMATIC)
		: t(THINKING_LABELS[value as (typeof THINKING)[number]] ?? value);

/** The fields every knight's form edits; a model or thinking level not chosen is `DEFAULT`. */
export interface FieldsDraft {
	displayName: string;
	prompt: string;
	model: string;
	thinking: string;
}

/** The models by provider (the part before the first slash), in the order listed; those without a provider stand alone. */
function modelGroups(
	models: readonly string[],
): { provider: string; models: string[] }[] {
	const groups: { provider: string; models: string[] }[] = [];
	for (const one of models) {
		const slash = one.indexOf("/");
		const provider = slash > 0 ? one.slice(0, slash) : "";
		const group = groups.find(
			(candidate) => candidate.provider === provider && provider !== "",
		);
		if (group) group.models.push(one);
		else groups.push({ provider, models: [one] });
	}
	return groups;
}

const options = (models: readonly string[]) =>
	models.map((one) => (
		<option key={one} value={one}>
			{one}
		</option>
	));

/**
 * A knight's name, prompt, model and thinking level, as the new-knight form, the agent sheet and a
 * temp-knight preset edit them. The prompt opens full screen; `onHistory` adds its history. One
 * grouped select picks the model, so a host with many models still shows one line.
 */
export function AgentFields(props: {
	draft: FieldsDraft;
	onChange(draft: FieldsDraft): void;
	models: readonly string[];
	/** The select's row for no model chosen. */
	defaultModel: string;
	/** The chip for no thinking level chosen; the assistant's Default unless given. */
	defaultThinking?: string;
	promptHint?: string;
	onHistory?(): void;
	/** Fields that stand right after the name, such as the new knight's permanent name. */
	children?: ReactNode;
}) {
	const { draft, onChange } = props;
	const [full, setFull] = useState(false);
	const nameId = useId();
	const promptId = useId();
	const modelId = useId();
	const models = [
		...new Set([
			...props.models,
			...(draft.model === DEFAULT ? [] : [draft.model]),
		]),
	];
	const setPrompt = (prompt: string) => onChange({ ...draft, prompt });
	return (
		<>
			<label htmlFor={nameId}>
				{t("Name")}
				<TextField
					id={nameId}
					value={draft.displayName}
					autoComplete="off"
					onChange={(event) =>
						onChange({ ...draft, displayName: event.target.value })
					}
				/>
			</label>
			{props.children}
			<div className="field">
				<div className="field-head">
					<label htmlFor={promptId}>{t("Prompt")}</label>
					<span className="field-tools">
						{props.onHistory ? (
							<button
								type="button"
								className="secondary compact"
								aria-haspopup="dialog"
								onClick={props.onHistory}
							>
								<Icon name="reset" size={16} />
								{t("History")}
							</button>
						) : null}
						<button
							type="button"
							className="secondary compact"
							aria-haspopup="dialog"
							onClick={() => setFull(true)}
						>
							<Expand />
							{t("Full screen")}
						</button>
					</span>
				</div>
				<TextArea
					id={promptId}
					rows={8}
					value={draft.prompt}
					onChange={(event) => setPrompt(event.target.value)}
				/>
				{props.promptHint ? (
					<span className="meta">{props.promptHint}</span>
				) : null}
			</div>
			<label htmlFor={modelId}>
				{t("Model")}
				<Select
					id={modelId}
					value={draft.model}
					onChange={(event) =>
						onChange({ ...draft, model: event.target.value })
					}
				>
					<option value={DEFAULT}>{props.defaultModel}</option>
					{modelGroups(models).map((group) =>
						group.provider === "" ? (
							options(group.models)
						) : (
							<optgroup key={group.provider} label={group.provider}>
								{options(group.models)}
							</optgroup>
						),
					)}
				</Select>
			</label>
			<Chips
				label={t("Thinking level")}
				value={draft.thinking}
				onChange={(thinking) => onChange({ ...draft, thinking })}
				options={THINKING.map((level) => ({
					value: level,
					label:
						level === DEFAULT && props.defaultThinking
							? props.defaultThinking
							: t(THINKING_LABELS[level]),
				}))}
			/>
			<Sheet
				open={full}
				title={t("Prompt")}
				size="full"
				onClose={() => setFull(false)}
			>
				<TextArea
					className="prompt-full"
					aria-label={t("Prompt")}
					value={draft.prompt}
					onChange={(event) => setPrompt(event.target.value)}
				/>
			</Sheet>
		</>
	);
}

/** The corners of a window: the prompt opens as large as the window. */
const Expand = () => (
	<svg
		viewBox="0 0 24 24"
		width={16}
		height={16}
		fill="none"
		stroke="currentColor"
		strokeWidth={1.8}
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
		focusable="false"
	>
		<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
	</svg>
);
