import {
	CATALOG,
	type CharacterInput,
	type CharacterSpec,
	CLASS_IDS,
} from "pi-roundtable/characters";
import type { ReactNode } from "react";
import { characterLabel, type LabelKind } from "../lib/character-labels.ts";
import { translate as t } from "../lib/messages.ts";
import { characterLabelBuild, PALETTES, PARTS } from "./creator-parts.ts";
import { ClassTile, Field, Strip, Swatch } from "./creator-pieces.tsx";
import { ColorField, Radio } from "./fields.tsx";

/** One group of the form, as the phone lists it: a title, what is chosen, a rejected field's message and the group's controls. */
export interface CreatorGroup {
	id: string;
	title: string;
	summary: string;
	/** The message of a rejected field in this group; the sheet is shut on a phone, so the list carries it. */
	error?: string | undefined;
	node: ReactNode;
}

/** What the form edits and how: the draft, the deferred copy its previews draw, the errors per field, and the change a control makes. */
export interface CreatorState {
	draft: CharacterSpec;
	shown: CharacterSpec;
	errors: Record<string, string>;
	change(input: CharacterInput): void;
	titleId: string;
	skins: readonly string[] | undefined;
}

/** The form's fields in the order a wide page stacks them, and the same fields as the groups of a phone's list. */
export function creatorFields(state: CreatorState): {
	classGrid: ReactNode;
	colors: ReactNode;
	parts: ReactNode[];
	body: ReactNode;
	groups: CreatorGroup[];
} {
	const { draft, shown, errors, change, titleId, skins } = state;

	const classGrid = (
		<Field field="class" title={t("Class")} error={errors.class}>
			<div className="creator-grid">
				{CLASS_IDS.map((id) => (
					<ClassTile
						key={id}
						id={id}
						base={shown}
						pressed={draft.class === id}
						onPick={() => change({ class: id, colors: draft.colors })}
					/>
				))}
			</div>
		</Field>
	);

	const colors = (
		<Field
			field="colors"
			title={t("Colors")}
			error={errors.colors ?? errors.palette}
		>
			<fieldset className="creator-swatches">
				<legend className="visually-hidden">{t("Palette")}</legend>
				{PALETTES.map((name) => {
					const colors = CATALOG.palettes[name];
					return (
						<Swatch
							key={name}
							data={{ "data-palette": name }}
							label={characterLabel("palette", name)}
							pressed={draft.palette === name}
							background={`linear-gradient(135deg, ${colors.primary} 52%, ${colors.trim} 52%)`}
							onPick={() => change({ palette: name })}
						/>
					);
				})}
			</fieldset>
			<div className="creator-custom">
				{(["primary", "secondary", "trim"] as const).map((key) => (
					<label key={key}>
						<span>
							{key === "primary"
								? t("Primary (the accent)")
								: key === "secondary"
									? t("Secondary")
									: t("Trim")}
						</span>
						<ColorField
							value={draft.colors[key]}
							onChange={(event) =>
								change({ colors: { [key]: event.target.value } })
							}
						/>
					</label>
				))}
			</div>
		</Field>
	);

	const parts = PARTS.map((part) => (
		<Field
			key={part.field}
			field={part.field}
			title={t(part.title)}
			error={errors[part.field]}
		>
			<Strip
				part={part}
				draft={draft}
				shown={shown}
				onPick={(id) => change({ [part.field]: id })}
			/>
		</Field>
	));

	const body = (
		<>
			<Field field="build" title={t("Build")} error={errors.build}>
				<fieldset className="segmented">
					<legend className="visually-hidden">{t("Build")}</legend>
					{(["slim", "regular", "stout"] as const).map((build) => (
						<label key={build} data-checked={draft.build === build}>
							<Radio
								name={`${titleId}-build`}
								checked={draft.build === build}
								onChange={() => change({ build })}
							/>
							{characterLabelBuild(build)}
						</label>
					))}
				</fieldset>
			</Field>
			<Field field="skin" title={t("Skin tone")} error={errors.skin}>
				<fieldset className="creator-swatches">
					<legend className="visually-hidden">{t("Skin tone")}</legend>
					{(skins ?? CATALOG.skins).map((hex, index) => (
						<Swatch
							// biome-ignore lint/suspicious/noArrayIndexKey: six fixed positions, and a host may repeat a tone
							key={index}
							data={{ "data-skin": String(index) }}
							label={t("Skin tone {n}", { n: index + 1 })}
							pressed={draft.skin === index}
							background={hex}
							onPick={() => change({ skin: index as CharacterSpec["skin"] })}
						/>
					))}
				</fieldset>
			</Field>
			<Field field="hairColor" title={t("Hair color")} error={errors.hairColor}>
				<fieldset className="creator-swatches">
					<legend className="visually-hidden">{t("Hair color")}</legend>
					{CATALOG.hairColors.map((hex, index) => (
						<Swatch
							key={hex}
							data={{ "data-hair-color": hex }}
							label={t("Hair color {n}", { n: index + 1 })}
							pressed={draft.hairColor === hex}
							background={hex}
							onPick={() => change({ hairColor: hex })}
						/>
					))}
					<ColorField
						aria-label={t("Hair color")}
						value={draft.hairColor}
						onChange={(event) =>
							change({ hairColor: event.target.value as `#${string}` })
						}
					/>
				</fieldset>
			</Field>
		</>
	);

	// On a phone each group opens in a bottom sheet instead of stacking down the page.
	const groups: CreatorGroup[] = [
		{
			id: "class",
			title: t("Class"),
			summary: characterLabel("class", draft.class),
			error: errors.class,
			node: classGrid,
		},
		{
			id: "colors",
			title: t("Colors"),
			summary: draft.palette
				? characterLabel("palette", draft.palette)
				: draft.colors.primary,
			error: errors.colors ?? errors.palette,
			node: colors,
		},
		...PARTS.map((part, index) => ({
			id: part.field,
			title: t(part.title),
			summary: characterLabel(part.field as LabelKind, draft[part.field]),
			error: errors[part.field],
			node: parts[index],
		})),
		{
			id: "body",
			title: t("Body"),
			summary: characterLabelBuild(draft.build),
			error: errors.build ?? errors.skin ?? errors.hairColor,
			node: body,
		},
	];

	return { classGrid, colors, parts, body, groups };
}
