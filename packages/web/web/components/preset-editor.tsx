import {
	type CharacterInput,
	type CharacterSpec,
	resolveCharacter,
	suggestCharacter,
} from "pi-roundtable/characters";
import { useEffect, useId, useState } from "react";
import type {
	AgentSkillsView,
	PresetRecruitsView,
	PresetSave,
	PresetView,
} from "../../src/api-types.ts";
import { closeAgentSheet, openAgentSheet } from "../lib/agent-sheet.ts";
import { ApiFailure, messageOf } from "../lib/api.ts";
import { translate as t } from "../lib/messages.ts";
import { teamApi } from "../lib/team-api.ts";
import { type KnightSeed, openTeamSheet } from "../lib/team-sheet.ts";
import { toast } from "../lib/toast.ts";
import {
	AgentFields,
	DEFAULT,
	type FieldsDraft,
	NAME,
} from "./agent-fields.tsx";
import { Chips } from "./chips.tsx";
import { Confirm } from "./confirm.tsx";
import { TextField } from "./fields.tsx";
import { KnightPicker } from "./knight-picker.tsx";
import { LookCreator, LookSummary } from "./look-pick.tsx";
import { PresetRecruits, TransferPreset } from "./preset-parts.tsx";
import { Sheet } from "./sheet.tsx";
import { SkillPicker } from "./skill-picker.tsx";
import { Failure } from "./states.tsx";

/** Whom a preset is available to, as the sheet's chips say it. */
type Share = "own" | "all" | "chosen";

const shareOf = (preset: PresetView | undefined): Share =>
	preset?.sharedWith === "all"
		? "all"
		: preset?.sharedWith?.length
			? "chosen"
			: "own";

const draftOf = (preset: KnightSeed | undefined): FieldsDraft => ({
	displayName: preset?.displayName ?? "",
	prompt: preset?.prompt ?? "",
	model: preset?.model ?? DEFAULT,
	thinking: preset?.thinking ?? DEFAULT,
});

/**
 * One preset's editor, stacked over the knight's sheet: its fields as a new knight's, the skills its
 * temp knight carries, its look and whom it is available to. The name is chosen once; a save sends
 * the preset whole. `seed` starts a new one from a knight, with the skills it carries; `readOnly`
 * shows another knight's shared preset, to open in that knight or to make a knight from. A saved
 * preset also shows who recruited from it (`recruits`, or read when left out) and, when it is the
 * knight's own, is transferred to another knight.
 */
export function PresetSheet(props: {
	agent: string;
	agentName: string;
	preset?: PresetView;
	seed?: KnightSeed;
	readOnly: boolean;
	models: readonly string[];
	recruits?: readonly PresetRecruitsView[];
	onClose(): void;
	onTransferred(to: string): void;
	onSaved(preset: PresetView): void;
	onDeleted(name: string): void;
}) {
	const { agent, preset, readOnly } = props;
	const from = preset ?? props.seed;
	const [name, setName] = useState(preset?.name ?? "");
	const [draft, setDraft] = useState(() => draftOf(from));
	const [skills, setSkills] = useState(from?.skills ?? []);
	const [look, setLook] = useState<CharacterInput | undefined>(from?.character);
	const [share, setShare] = useState(() => shareOf(preset));
	const [chosen, setChosen] = useState<string[]>(() =>
		Array.isArray(preset?.sharedWith) ? preset.sharedWith : [],
	);
	const [picking, setPicking] = useState(false);
	const [catalog, setCatalog] = useState<AgentSkillsView>();
	const [error, setError] = useState<string>();
	const [saving, setSaving] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const nameId = useId();
	const seeded = props.seed !== undefined;
	useEffect(() => {
		let current = true;
		teamApi.skills(agent).then(
			(loaded) => {
				if (!current) return;
				setCatalog(loaded);
				// A copy of the knight carries its skills, the built-in ones aside.
				if (seeded)
					setSkills(
						loaded.skills
							.filter((skill) => skill.carried && !skill.builtin)
							.map((skill) => skill.name),
					);
			},
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
	}, [agent, seeded]);
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
	const fields = {
		displayName: draft.displayName.trim(),
		prompt: draft.prompt,
		skills,
		...(look ? { character: look } : {}),
		...(draft.model !== DEFAULT ? { model: draft.model } : {}),
		...(draft.thinking !== DEFAULT ? { thinking: draft.thinking } : {}),
	};
	// A knight made from the preset is a copy: the new knight's form, filled in, over the page.
	const makeKnight = () => {
		closeAgentSheet();
		openTeamSheet({ kind: "new-agent", from: fields });
	};
	const save = async () => {
		setSaving(true);
		setError(undefined);
		const body: PresetSave = {
			...fields,
			sharedWith:
				share === "all"
					? "all"
					: share === "chosen" && chosen.length > 0
						? chosen
						: null,
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
				preset
					? t("Preset: {name}", {
							name: readOnly ? `${agent}/${preset.name}` : preset.name,
						})
					: t("New preset")
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
						if (ready && !saving && !readOnly) save();
					}}
				>
					<fieldset className="stack" disabled={readOnly}>
						<label htmlFor={nameId}>
							{t("Preset name")}
							<TextField
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
						{readOnly ? null : (
							<Chips
								label={t("Available to")}
								value={share}
								onChange={(value) => setShare(value as Share)}
								options={[
									{
										value: "own",
										label: t("Only {name}", { name: props.agentName }),
									},
									{ value: "all", label: t("All knights") },
									{ value: "chosen", label: t("Chosen knights") },
								]}
							/>
						)}
						{share === "chosen" && !readOnly ? (
							<KnightPicker
								label={t("Chosen knights")}
								chosen={chosen}
								onChange={setChosen}
								except={[agent]}
							/>
						) : null}
					</fieldset>
					{preset ? (
						<PresetRecruits
							agent={agent}
							name={preset.name}
							{...(props.recruits ? { recruits: props.recruits } : {})}
						/>
					) : null}
					{error ? <Failure message={error} /> : null}
					<div className="actions">
						{preset || readOnly ? (
							<button
								type="button"
								className="secondary"
								disabled={!ready}
								onClick={makeKnight}
							>
								{t("Create a knight from this")}
							</button>
						) : null}
						{readOnly ? (
							<button
								type="button"
								onClick={() =>
									openAgentSheet(agent, { look: false, skills: false })
								}
							>
								{t("Open in {name}", { name: props.agentName })}
							</button>
						) : null}
						{preset && !readOnly ? (
							<TransferPreset
								agent={agent}
								name={preset.name}
								onTransferred={props.onTransferred}
							/>
						) : null}
						{preset && !readOnly ? (
							<button
								type="button"
								className="danger"
								onClick={() => setDeleting(true)}
							>
								{t("Delete preset")}
							</button>
						) : null}
						{readOnly ? null : (
							<button type="submit" disabled={!ready || saving}>
								{saving ? t("Saving…") : t("Save")}
							</button>
						)}
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
