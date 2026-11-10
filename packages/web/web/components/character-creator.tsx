import {
	AVATAR_STATES,
	type AvatarState,
	type CharacterInput,
	type CharacterSpec,
	resolveCharacter,
	suggestCharacter,
} from "pi-roundtable/characters";
import { useDeferredValue, useEffect, useId, useRef, useState } from "react";
import type { AgentProfileView } from "../../src/api-types.ts";
import { ApiFailure, api, messageOf } from "../lib/api.ts";
import { useAccentStyle } from "../lib/characters.ts";
import { CREATOR_CSS } from "../lib/creator-style.ts";
import { installStyle } from "../lib/lazy-style.ts";
import { useMedia } from "../lib/media.ts";
import { translate as t } from "../lib/messages.ts";
import { useSkins } from "../lib/skins.ts";
import { toast } from "../lib/toast.ts";
import { PageCharacter } from "./character.tsx";
import { Confirm } from "./confirm.tsx";
import { creatorFields } from "./creator-fields.tsx";
import { type Leaving, useLeaveGuard } from "./creator-leave.tsx";
import {
	canon,
	inputOf,
	RENDERED_FIELDS,
	randomInput,
	STATE_LABELS,
} from "./creator-parts.ts";
import { Sheet } from "./sheet.tsx";

/**
 * The creator and re-dress form of a character, an agent's or a person's own: a live preview, the
 * 24 classes, the palettes and colors, and the parts. It edits a draft; Save sends it as
 * `PUT …/character`.
 */
export function CharacterCreator(props: {
	name: string;
	displayName: string;
	/** The agent's role, which "Suggest from role" reads; a person has none, and is not offered it. */
	prompt?: string;
	/** The saved character; for an agent not made yet, the look it would be given. */
	character: CharacterSpec;
	/** After a save: the agent's profile, with its new character. */
	onSaved?(profile: AgentProfileView): void;
	/**
	 * Saves the draft in place of the agent's `PUT …/character` (a person's own knight). A refusal
	 * that names a field is placed on it, as the agent's is.
	 */
	save?(look: CharacterInput): Promise<void>;
	/** `character` is a look nothing has saved yet, so it can be saved as it stands. */
	fresh?: boolean;
	/**
	 * For an agent that does not exist yet: nothing is saved, and the button hands the draft to this
	 * instead (the look as input, and as the spec it resolves to). `onCancel` leaves without one.
	 */
	onPick?(look: CharacterInput, spec: CharacterSpec): void;
	onCancel?(): void;
}) {
	installStyle("creator", CREATOR_CSS);
	const [draft, setDraft] = useState(props.character);
	const shown = useDeferredValue(draft);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [saving, setSaving] = useState(false);
	const [state, setState] = useState<AvatarState>("idle");
	const [leaving, setLeaving] = useState<Leaving>();
	const [section, setSection] = useState<string>();
	const phone = useMedia("(max-width: 719px)");
	const root = useRef<HTMLFormElement>(null);
	const titleId = useId();
	const accent = useAccentStyle(draft);
	const skins = useSkins();
	const dirty = canon(draft) !== canon(props.character);
	const { prompt } = props;

	// A new saved character (after Save, or another tab's change) starts a fresh draft.
	useEffect(() => setDraft(props.character), [props.character]);

	// Unsaved changes ask before the page is left. A look still to be picked for an agent not made yet is not a change to something saved.
	useLeaveGuard(root, dirty && !props.onPick, setLeaving);

	const change = (input: CharacterInput) => {
		setErrors({});
		setDraft((current) => resolveCharacter(input, current));
	};

	const save = async () => {
		if (props.onPick) {
			props.onPick(inputOf(draft), draft);
			return;
		}
		setSaving(true);
		setErrors({});
		try {
			if (props.save) await props.save(inputOf(draft));
			else props.onSaved?.(await api.setCharacter(props.name, inputOf(draft)));
			toast(t("Saved."));
		} catch (failure) {
			const named =
				failure instanceof ApiFailure && failure.field
					? failure.field.split(".")[0]
					: undefined;
			// A field the form does not show has no place to carry its message but the general one.
			const field = named && RENDERED_FIELDS.has(named) ? named : "*";
			setErrors({ [field]: messageOf(failure) });
		} finally {
			setSaving(false);
		}
	};

	const discard = async () => {
		const target = leaving;
		setDraft(props.character);
		setErrors({});
		if (target?.kind === "link") {
			// The draft is the saved look again, so the link is no longer held back.
			setTimeout(() => target.anchor.click(), 0);
		} else if (target?.kind === "navigate") target.proceed();
		else props.onCancel?.();
	};

	const { groups, classGrid, colors, parts, body } = creatorFields({
		draft,
		shown,
		errors,
		change,
		titleId,
		skins,
	});

	return (
		<form
			ref={root}
			className="creator"
			style={accent}
			aria-labelledby={titleId}
			onSubmit={(event) => {
				event.preventDefault();
				if ((dirty || props.onPick || props.fresh) && !saving) save();
			}}
		>
			<h2 id={titleId} className="visually-hidden">
				{t("Character of {name}", { name: props.displayName })}
			</h2>
			<div className="creator-preview">
				<PageCharacter
					spec={draft}
					name={props.name}
					state={state}
					size={176}
					label={t("{name}, {state}", {
						name: props.displayName,
						state: t(STATE_LABELS[state]),
					})}
				/>
				<button
					type="button"
					className="secondary"
					data-action="cycle"
					onClick={() =>
						setState(
							(current) =>
								AVATAR_STATES[
									(AVATAR_STATES.indexOf(current) + 1) % AVATAR_STATES.length
								] ?? "idle",
						)
					}
				>
					{t("Preview states")}
				</button>
				<span className="meta" aria-live="polite">
					{t(STATE_LABELS[state])}
				</span>
			</div>
			<div className="creator-body">
				{errors["*"] ? (
					<p className="field-error" role="alert" data-field="*">
						{errors["*"]}
					</p>
				) : null}
				{phone ? (
					<ul className="creator-sections">
						{groups.map((group) => (
							<li key={group.id}>
								<button
									type="button"
									className="creator-section secondary"
									onClick={() => setSection(group.id)}
								>
									<strong>{group.title}</strong>
									<span className="meta">{group.summary}</span>
									{group.error ? (
										<span className="field-error" role="alert">
											{group.error}
										</span>
									) : null}
								</button>
							</li>
						))}
					</ul>
				) : (
					<>
						{classGrid}
						{colors}
						{parts}
						{body}
					</>
				)}
				<div className="actions creator-actions">
					{prompt === undefined ? null : (
						<button
							type="button"
							className="secondary"
							data-action="suggest"
							onClick={() => {
								setErrors({});
								setDraft(
									suggestCharacter({
										name: props.name,
										displayName: props.displayName,
										prompt,
									}),
								);
							}}
						>
							{t("Suggest from role")}
						</button>
					)}
					<button
						type="button"
						className="secondary"
						data-action="randomize"
						onClick={() => change(randomInput())}
					>
						{t("Randomize")}
					</button>
					<button
						type="button"
						className="secondary"
						data-action="cancel"
						onClick={() => {
							// A look still to be picked is not a change to something saved; anything else unsaved asks first.
							if (dirty && !props.onPick) setLeaving({ kind: "cancel" });
							else props.onCancel?.();
						}}
					>
						{t("Cancel")}
					</button>
					<button
						type="submit"
						data-action="save"
						disabled={(!dirty && !props.onPick && !props.fresh) || saving}
					>
						{saving
							? t("Saving…")
							: props.onPick
								? t("Use this look")
								: t("Save")}
					</button>
				</div>
			</div>
			<Sheet
				open={phone && section !== undefined}
				title={groups.find((group) => group.id === section)?.title ?? ""}
				onClose={() => setSection(undefined)}
			>
				<div className="stack">
					{groups.find((group) => group.id === section)?.node}
				</div>
			</Sheet>
			<Confirm
				open={leaving !== undefined}
				title={t("Discard your changes?")}
				confirmLabel={t("Discard")}
				cancelLabel={t("Keep editing")}
				tone="danger"
				onClose={() => setLeaving(undefined)}
				onConfirm={discard}
			>
				<p>
					{t("The new look for {name} has not been saved.", {
						name: props.displayName,
					})}
				</p>
			</Confirm>
		</form>
	);
}
