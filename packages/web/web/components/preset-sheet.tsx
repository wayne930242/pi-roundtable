import {
	type CharacterInput,
	type CharacterSpec,
	resolveCharacter,
	suggestCharacter,
} from "pi-roundtable/characters";
import { useEffect, useId, useState } from "react";
import type {
	AgentSkillsView,
	PresetSave,
	PresetsView,
	PresetView,
} from "../../src/api-types.ts";
import { ApiFailure, api, messageOf } from "../lib/api.ts";
import { translate as t } from "../lib/messages.ts";
import { teamApi } from "../lib/team-api.ts";
import { toast } from "../lib/toast.ts";
import {
	AgentFields,
	DEFAULT,
	type FieldsDraft,
	NAME,
} from "./agent-fields.tsx";
import { Confirm } from "./confirm.tsx";
import { LookCreator, LookSummary } from "./look-pick.tsx";
import { Sheet } from "./sheet.tsx";
import { SkillPicker } from "./skill-picker.tsx";
import { Failure } from "./states.tsx";

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

/**
 * A knight's temp-knight presets on its sheet: one row each, a tap opening the preset's editor, and a
 * new one up to the most it may keep. Shown only where the host makes temp knights.
 */
export function PresetCard(props: {
	agent: string;
	models: readonly string[];
}) {
	const [view, setView] = useState<PresetsView>();
	const [error, setError] = useState<string>();
	// The preset being edited, or `null` for a new one.
	const [editing, setEditing] = useState<PresetView | null>();
	useEffect(() => {
		let current = true;
		// Without a session to read, as without temp knights, the card stays away.
		api
			.session()
			.then(
				(session) =>
					session.helpers ? teamApi.presets(props.agent) : undefined,
				() => undefined,
			)
			.then(
				(loaded) => current && loaded && setView(loaded),
				(failure) => current && setError(messageOf(failure)),
			);
		return () => {
			current = false;
		};
	}, [props.agent]);
	if (error) return <Failure message={error} />;
	if (!view) return null;
	const { presets, max } = view;
	const keep = (saved: PresetView) =>
		setView({
			max,
			presets: [...presets.filter((p) => p.name !== saved.name), saved].sort(
				(a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
			),
		});
	return (
		<section className="card stack" data-presets="">
			<h3>
				{t("Temp knight presets ({count}/{max})", {
					count: presets.length,
					max,
				})}
			</h3>
			{presets.length > 0 ? (
				<ul className="menu">
					{presets.map((preset) => (
						<li key={preset.name}>
							<button
								type="button"
								className="menu-item"
								data-preset={preset.name}
								aria-haspopup="dialog"
								onClick={() => setEditing(preset)}
							>
								<span className="menu-text">
									<strong>
										{preset.name} · {preset.displayName}
									</strong>
									<span className="meta">
										{t("Skills ({count})", { count: preset.skills.length })} ·{" "}
										{firstLine(preset.prompt)}
									</span>
								</span>
							</button>
						</li>
					))}
				</ul>
			) : null}
			<div className="actions">
				<button
					type="button"
					className="secondary"
					disabled={presets.length >= max}
					onClick={() => setEditing(null)}
				>
					{t("New preset")}
				</button>
			</div>
			{editing !== undefined ? (
				<PresetSheet
					agent={props.agent}
					preset={editing ?? undefined}
					models={props.models}
					onClose={() => setEditing(undefined)}
					onSaved={(saved) => {
						keep(saved);
						setEditing(saved);
					}}
					onDeleted={(name) => {
						setView({ max, presets: presets.filter((p) => p.name !== name) });
						setEditing(undefined);
					}}
				/>
			) : null}
		</section>
	);
}

const draftOf = (preset: PresetView | undefined): FieldsDraft => ({
	displayName: preset?.displayName ?? "",
	prompt: preset?.prompt ?? "",
	model: preset?.model ?? DEFAULT,
	thinking: preset?.thinking ?? DEFAULT,
});

/**
 * One preset's editor, stacked over the knight's sheet: its fields as a new knight's, the skills its
 * temp knight carries and its look. The name is chosen once; a save sends the preset whole.
 */
function PresetSheet(props: {
	agent: string;
	preset: PresetView | undefined;
	models: readonly string[];
	onClose(): void;
	onSaved(preset: PresetView): void;
	onDeleted(name: string): void;
}) {
	const { agent, preset } = props;
	const [name, setName] = useState(preset?.name ?? "");
	const [draft, setDraft] = useState(() => draftOf(preset));
	const [skills, setSkills] = useState(preset?.skills ?? []);
	const [look, setLook] = useState<CharacterInput | undefined>(
		preset?.character,
	);
	const [picking, setPicking] = useState(false);
	const [catalog, setCatalog] = useState<AgentSkillsView>();
	const [error, setError] = useState<string>();
	const [saving, setSaving] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const nameId = useId();
	useEffect(() => {
		let current = true;
		teamApi.skills(agent).then(
			(loaded) => current && setCatalog(loaded),
			(failure) => {
				// The host has no skills addon: a preset carries none.
				if (
					current &&
					!(failure instanceof ApiFailure && failure.status === 404)
				)
					setError(messageOf(failure));
			},
		);
		return () => {
			current = false;
		};
	}, [agent]);
	const who = { name: name || "new", ...draft };
	const suggested = suggestCharacter(who);
	let spec: CharacterSpec = suggested;
	try {
		if (look) spec = resolveCharacter(look, suggested);
	} catch {
		// A look the server would refuse shows the suggestion; the save names the field.
	}
	const ready =
		NAME.test(name) && draft.displayName.trim() !== "" && draft.prompt.trim();
	const choices =
		catalog?.skills.map((skill) => ({
			...skill,
			carried: skill.builtin || skills.includes(skill.name),
		})) ?? [];
	const save = async () => {
		setSaving(true);
		setError(undefined);
		const body: PresetSave = {
			displayName: draft.displayName.trim(),
			prompt: draft.prompt,
			skills,
			...(look ? { character: look } : {}),
			...(draft.model !== DEFAULT ? { model: draft.model } : {}),
			...(draft.thinking !== DEFAULT ? { thinking: draft.thinking } : {}),
		};
		try {
			const saved = await teamApi.savePreset(agent, name, body);
			toast(saved.replaced ? t("Saved the preset.") : t("Created the preset."));
			props.onSaved(saved.preset);
		} catch (failure) {
			setError(messageOf(failure));
		} finally {
			setSaving(false);
		}
	};
	return (
		<Sheet
			open
			title={
				preset ? t("Preset: {name}", { name: preset.name }) : t("New preset")
			}
			size="wide"
			onClose={props.onClose}
		>
			{picking ? (
				<LookCreator
					{...who}
					spec={spec}
					onPick={(input) => {
						setLook(input);
						setPicking(false);
					}}
					onCancel={() => setPicking(false)}
				/>
			) : (
				<form
					className="stack form preset-sheet"
					onSubmit={(event) => {
						event.preventDefault();
						if (ready && !saving) save();
					}}
				>
					<label htmlFor={nameId}>
						{t("Preset name")}
						<input
							id={nameId}
							value={name}
							readOnly={preset !== undefined}
							autoComplete="off"
							autoCapitalize="none"
							spellCheck={false}
							aria-invalid={name !== "" && !NAME.test(name)}
							onChange={(event) => setName(event.target.value)}
						/>
						<span className="meta">
							{t(
								"Lowercase letters, digits and dashes, up to 32. It cannot be changed later.",
							)}
						</span>
					</label>
					<AgentFields
						draft={draft}
						onChange={setDraft}
						models={props.models}
						defaultModel={t("The knight's own")}
						defaultThinking={t("The knight's own")}
					/>
					{catalog ? (
						<div className="stack">
							<h4>{t("Skills ({count})", { count: skills.length })}</h4>
							<SkillPicker
								skills={choices}
								who={draft.displayName || name}
								onFlip={(skill, next) =>
									setSkills(
										next
											? [...skills, skill]
											: skills.filter((one) => one !== skill),
									)
								}
								onApplyGroup={async (group, on) => {
									const locked = new Set(
										choices.filter((s) => s.builtin).map((s) => s.name),
									);
									const added = on
										? group.skills.filter((s) => !skills.includes(s))
										: [];
									const removed = on
										? []
										: group.skills.filter(
												(s) => skills.includes(s) && !locked.has(s),
											);
									setSkills([
										...skills.filter((s) => !removed.includes(s)),
										...added,
									]);
									return { added, removed };
								}}
							/>
						</div>
					) : null}
					<LookSummary
						spec={spec}
						name={who.name}
						displayName={draft.displayName}
						chosen={look !== undefined}
						onChoose={() => setPicking(true)}
					/>
					{error ? <Failure message={error} /> : null}
					<div className="actions">
						{preset ? (
							<button
								type="button"
								className="danger"
								onClick={() => setDeleting(true)}
							>
								{t("Delete preset")}
							</button>
						) : null}
						<button type="submit" disabled={!ready || saving}>
							{saving ? t("Saving…") : t("Save")}
						</button>
					</div>
				</form>
			)}
			<Confirm
				open={deleting}
				title={t("Delete {name}?", { name })}
				confirmLabel={t("Delete preset")}
				tone="danger"
				onClose={() => setDeleting(false)}
				onConfirm={async () => {
					await teamApi.deletePreset(agent, name);
					toast(t("Deleted the preset."));
					setDeleting(false);
					props.onDeleted(name);
				}}
			>
				<p>{t("This cannot be undone.")}</p>
			</Confirm>
		</Sheet>
	);
}
