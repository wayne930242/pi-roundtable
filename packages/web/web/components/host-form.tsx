import { type FormEvent, useId, useState } from "react";
import type {
	FormFieldView,
	FormInput,
	FormSpecView,
} from "../../src/api-types.ts";
import { messageOf } from "../lib/api.ts";
import { translate as t } from "../lib/messages.ts";
import { Select } from "./select.tsx";
import { Failure } from "./states.tsx";

type Values = Record<string, string | string[]>;

/** What a form starts with: each field's `initial`, else empty. */
export function initialValues(fields: readonly FormFieldView[]): Values {
	const values: Values = {};
	for (const field of fields) {
		if (field.type === "multiselect")
			values[field.name] = [...toList(field.initial)];
		else values[field.name] = toList(field.initial)[0] ?? "";
	}
	return values;
}

const toList = (initial: string | readonly string[] | undefined): string[] =>
	initial === undefined
		? []
		: typeof initial === "string"
			? [initial]
			: [...initial];

/** The input the form submits: a blank optional field is left out. */
function inputOf(fields: readonly FormFieldView[], values: Values): FormInput {
	const input: Record<string, string | readonly string[]> = {};
	for (const field of fields) {
		const value = values[field.name];
		if (value === undefined || value === "" || value.length === 0) continue;
		input[field.name] = value;
	}
	return input;
}

type ChoiceField = Extract<FormFieldView, { options: unknown }>;

/** A select, or a list of checkboxes; with `search` a box filters the options first. */
function Choice(props: {
	field: ChoiceField;
	id: string;
	value: string | string[];
	described: string | undefined;
	onChange(value: string | string[]): void;
}) {
	const { field, value } = props;
	const [needle, setNeedle] = useState("");
	const shown = field.search
		? field.options.filter((option) =>
				option.label.toLowerCase().includes(needle.trim().toLowerCase()),
			)
		: field.options;
	const search = field.search ? (
		<input
			type="search"
			value={needle}
			placeholder={t("Search…")}
			aria-label={t("Search {name}", { name: field.label })}
			onChange={(event) => setNeedle(event.target.value)}
		/>
	) : null;
	if (field.type === "select")
		return (
			<>
				{search}
				<Select
					id={props.id}
					value={String(value)}
					required={field.required === true}
					aria-describedby={props.described}
					{...(field.search ? { size: 6 } : {})}
					onChange={(event) => props.onChange(event.target.value)}
				>
					{field.required ? null : <option value="">{t("None")}</option>}
					{shown.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</Select>
			</>
		);
	const chosen = new Set(Array.isArray(value) ? value : []);
	return (
		<>
			{search}
			<fieldset aria-describedby={props.described}>
				{shown.map((option) => (
					<label key={option.value}>
						<input
							type="checkbox"
							checked={chosen.has(option.value)}
							onChange={(event) => {
								const next = new Set(chosen);
								if (event.target.checked) next.add(option.value);
								else next.delete(option.value);
								props.onChange(
									field.options
										.filter((one) => next.has(one.value))
										.map((one) => one.value),
								);
							}}
						/>
						{option.label}
					</label>
				))}
			</fieldset>
		</>
	);
}

function Field(props: {
	field: FormFieldView;
	value: string | string[];
	error: string | undefined;
	onChange(value: string | string[]): void;
}) {
	const { field, value } = props;
	const id = useId();
	const hint = "hint" in field ? field.hint : undefined;
	const described = props.error || hint ? `${id}-note` : undefined;
	let control: React.ReactNode;
	if ("options" in field)
		control = (
			<Choice
				field={field}
				id={id}
				value={value}
				described={described}
				onChange={props.onChange}
			/>
		);
	else if (field.type === "textarea")
		control = (
			<textarea
				id={id}
				rows={5}
				value={String(value)}
				maxLength={field.max ?? 8000}
				required={field.required === true}
				aria-describedby={described}
				onChange={(event) => props.onChange(event.target.value)}
			/>
		);
	else
		control = (
			<input
				id={id}
				type={field.type === "url" ? "url" : "text"}
				value={String(value)}
				maxLength={field.max ?? 500}
				required={field.required === true}
				aria-describedby={described}
				onChange={(event) => props.onChange(event.target.value)}
			/>
		);
	return (
		<div className="host-field">
			{field.type === "multiselect" ? (
				<span className="field-label">{field.label}</span>
			) : (
				<label htmlFor={id}>{field.label}</label>
			)}
			{control}
			{props.error || hint ? (
				<span
					id={`${id}-note`}
					className={props.error ? "field-error" : "hint"}
					role={props.error ? "alert" : undefined}
				>
					{props.error ?? hint}
				</span>
			) : null}
		</div>
	);
}

/**
 * A host's form: its fields, a submit button, and what the host answered when it refused (an error,
 * at the field it names). `onSubmit` throws or returns an error text to keep the form open.
 */
export function HostForm(props: {
	spec: FormSpecView;
	onSubmit(
		input: FormInput,
	): Promise<{ error: string; field?: string } | undefined>;
	onCancel?: () => void;
}) {
	const { spec } = props;
	const [values, setValues] = useState(() => initialValues(spec.fields));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<{ error: string; field?: string }>();
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (busy) return;
		setBusy(true);
		setError(undefined);
		try {
			setError(await props.onSubmit(inputOf(spec.fields, values)));
		} catch (failure) {
			setError({ error: messageOf(failure) });
		} finally {
			setBusy(false);
		}
	};
	return (
		<form className="host-form" onSubmit={submit}>
			{spec.fields.map((field) => (
				<Field
					key={field.name}
					field={field}
					value={values[field.name] ?? ""}
					error={error?.field === field.name ? error.error : undefined}
					onChange={(value) =>
						setValues((current) => ({ ...current, [field.name]: value }))
					}
				/>
			))}
			{error && !spec.fields.some((field) => field.name === error.field) ? (
				<Failure message={error.error} />
			) : null}
			<div className="actions">
				{props.onCancel ? (
					<button
						type="button"
						className="secondary"
						disabled={busy}
						onClick={props.onCancel}
					>
						{t("Cancel")}
					</button>
				) : null}
				<button type="submit" disabled={busy}>
					{spec.submit}
				</button>
			</div>
		</form>
	);
}
