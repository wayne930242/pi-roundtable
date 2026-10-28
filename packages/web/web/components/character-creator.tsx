import {
	AVATAR_STATES,
	type AvatarState,
	CATALOG,
	type CharacterInput,
	type CharacterSpec,
	CLASS_IDS,
	type ClassId,
	type PaletteName,
	resolveCharacter,
	suggestCharacter,
} from "pi-roundtable/characters";
import {
	memo,
	type ReactNode,
	useDeferredValue,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import type { AgentProfileView } from "../../src/api-types.ts";
import { ApiFailure, api, messageOf } from "../lib/api.ts";
import {
	characterJobs,
	characterLabel,
	type LabelKind,
} from "../lib/character-labels.ts";
import { useAccentStyle } from "../lib/characters.ts";
import { useMedia } from "../lib/media.ts";
import { translate as t } from "../lib/messages.ts";
import { blockNavigation } from "../lib/router.ts";
import { toast } from "../lib/toast.ts";
import { PageCharacter } from "./character.tsx";
import { Confirm } from "./confirm.tsx";
import { Sheet } from "./sheet.tsx";

/** The fields a part strip changes. */
type PartField = "hat" | "outfit" | "prop" | "hair" | "beard" | "accessory";

const PARTS: {
	field: PartField;
	title: string;
	ids: readonly string[];
}[] = [
	{ field: "hat", title: "Hat", ids: CATALOG.hats },
	{ field: "outfit", title: "Outfit", ids: CATALOG.outfits },
	{ field: "prop", title: "Prop", ids: CATALOG.props },
	{ field: "hair", title: "Hair", ids: CATALOG.hair },
	{ field: "beard", title: "Beard", ids: ["none", ...CATALOG.beards] },
	{
		field: "accessory",
		title: "Accessory",
		ids: ["none", ...CATALOG.accessories],
	},
];

/** The fields the form renders an error under; any other field a server names is reported in the general slot. */
const RENDERED_FIELDS: ReadonlySet<string> = new Set([
	"class",
	"colors",
	"palette",
	"build",
	"skin",
	"hairColor",
	...PARTS.map((part) => part.field),
]);

const PALETTES = Object.keys(CATALOG.palettes) as PaletteName[];

const STATE_LABELS: Record<AvatarState, string> = {
	idle: "Idle",
	thinking: "Thinking",
	working: "Working",
	waiting: "Waiting for you",
	done: "Done",
	error: "Error",
	sleepy: "Sleepy",
};

const BUILD_LABELS: Record<CharacterSpec["build"], string> = {
	slim: "Slim",
	regular: "Regular",
	stout: "Stout",
};

/** The fields the server takes, from a spec; `palette` is left to the server to work out from the colors. */
function inputOf(spec: CharacterSpec): CharacterInput {
	return {
		class: spec.class,
		outfit: spec.outfit,
		hat: spec.hat,
		prop: spec.prop,
		hair: spec.hair,
		beard: spec.beard,
		accessory: spec.accessory,
		build: spec.build,
		skin: spec.skin,
		hairColor: spec.hairColor,
		colors: { ...spec.colors },
	};
}

/** A spec as a string that is the same for the same look, to tell a change from none. */
const canon = (spec: CharacterSpec): string => JSON.stringify(inputOf(spec));

const pick = <T,>(list: readonly T[]): T =>
	list[Math.floor(Math.random() * list.length)] as T;

/** A random look from the catalog. */
function randomInput(): CharacterInput {
	return {
		class: pick(CLASS_IDS),
		outfit: pick(CATALOG.outfits),
		hat: pick(CATALOG.hats),
		prop: pick(CATALOG.props),
		hair: pick(CATALOG.hair),
		beard: pick(["none", ...CATALOG.beards] as const),
		accessory: pick(["none", ...CATALOG.accessories] as const),
		build: pick(["slim", "regular", "stout"] as const),
		skin: pick([0, 1, 2, 3, 4, 5] as const),
		hairColor: pick(CATALOG.hairColors),
		palette: pick(PALETTES),
	};
}

/** One choice of a strip or grid: a small drawing and its name. */
const Tile = memo(function Tile(props: {
	data: Record<string, string>;
	spec: CharacterSpec;
	size: number;
	label: string;
	hint?: string | undefined;
	pressed: boolean;
	onPick(): void;
}) {
	return (
		<button
			type="button"
			className="creator-tile"
			aria-pressed={props.pressed}
			title={props.hint ? `${props.label} — ${props.hint}` : props.label}
			onClick={props.onPick}
			{...props.data}
		>
			<PageCharacter spec={props.spec} size={props.size} live={false} />
			<span>{props.label}</span>
		</button>
	);
});

/** The wearer with each choice of one field, drawn small, so the strip shows what the choice does. */
function usePreviews(
	base: CharacterSpec,
	field: PartField,
	ids: readonly string[],
): CharacterSpec[] {
	const rest = JSON.stringify({ ...base, [field]: 0 });
	// biome-ignore lint/correctness/useExhaustiveDependencies: `rest` is the base without the field
	return useMemo(
		() => ids.map((id) => ({ ...base, [field]: id }) as CharacterSpec),
		[rest, field, ids],
	);
}

function Strip(props: {
	part: (typeof PARTS)[number];
	draft: CharacterSpec;
	shown: CharacterSpec;
	onPick(id: string): void;
}) {
	const { part } = props;
	const previews = usePreviews(props.shown, part.field, part.ids);
	return (
		<div className="creator-strip">
			{part.ids.map((id, index) => (
				<Tile
					key={id}
					data={{ [`data-${part.field}`]: id }}
					spec={previews[index] as CharacterSpec}
					size={44}
					label={characterLabel(part.field as LabelKind, id)}
					pressed={props.draft[part.field] === id}
					onPick={() => props.onPick(id)}
				/>
			))}
		</div>
	);
}

/** A swatch button. */
function Swatch(props: {
	data: Record<string, string>;
	label: string;
	pressed: boolean;
	background: string;
	onPick(): void;
}) {
	return (
		<button
			type="button"
			className="creator-swatch"
			aria-pressed={props.pressed}
			aria-label={props.label}
			title={props.label}
			style={{ background: props.background }}
			onClick={props.onPick}
			{...props.data}
		/>
	);
}

function Field(props: {
	field: string;
	title?: string;
	error: string | undefined;
	children: ReactNode;
}) {
	return (
		<div className="creator-field" data-field={props.field}>
			{props.title ? <h3>{props.title}</h3> : null}
			{props.children}
			{props.error ? (
				<p className="field-error" role="alert">
					{props.error}
				</p>
			) : null}
		</div>
	);
}

/** What the person is trying to leave with unsaved changes: the form itself, or by a link. */
type Leaving =
	| { kind: "cancel" }
	| { kind: "link"; anchor: HTMLAnchorElement }
	| { kind: "navigate"; proceed(): void };

/**
 * The creator and re-dress form of an agent's character: a live preview, the 24 classes, the
 * palettes and colors, and the parts. It edits a draft; Save sends it as `PUT …/character`.
 */
export function CharacterCreator(props: {
	name: string;
	displayName: string;
	prompt: string;
	/** The saved character. */
	character: CharacterSpec;
	onSaved(profile: AgentProfileView): void;
}) {
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
	const dirty = canon(draft) !== canon(props.character);

	// A new saved character (after Save, or another tab's change) starts a fresh draft.
	useEffect(() => setDraft(props.character), [props.character]);

	// Unsaved changes ask before the page is left: closing or reloading, and a link inside the app.
	useEffect(() => {
		if (!dirty) return;
		const beforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
		const onClick = (event: MouseEvent) => {
			if (
				event.button !== 0 ||
				event.metaKey ||
				event.ctrlKey ||
				event.shiftKey ||
				event.altKey
			)
				return;
			const anchor =
				event.target instanceof Element ? event.target.closest("a") : null;
			if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
			if (root.current?.contains(anchor)) return;
			event.preventDefault();
			event.stopPropagation();
			setLeaving({ kind: "link", anchor });
		};
		// Navigation by code (the room switcher) and the browser's back or a swipe.
		const release = blockNavigation((proceed) =>
			setLeaving({ kind: "navigate", proceed }),
		);
		window.addEventListener("beforeunload", beforeUnload);
		document.addEventListener("click", onClick, true);
		return () => {
			release();
			window.removeEventListener("beforeunload", beforeUnload);
			document.removeEventListener("click", onClick, true);
		};
	}, [dirty]);

	const change = (input: CharacterInput) => {
		setErrors({});
		setDraft((current) => resolveCharacter(input, current));
	};

	const save = async () => {
		setSaving(true);
		setErrors({});
		try {
			const profile = await api.setCharacter(props.name, inputOf(draft));
			props.onSaved(profile);
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
	};

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
						<input
							type="color"
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
							<input
								type="radio"
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
					{CATALOG.skins.map((hex, index) => (
						<Swatch
							key={hex}
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
					<input
						type="color"
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
	const groups: {
		id: string;
		title: string;
		summary: string;
		/** The message of a rejected field in this group; the sheet is shut on a phone, so the list carries it. */
		error?: string | undefined;
		node: ReactNode;
	}[] = [
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

	return (
		<form
			ref={root}
			className="creator"
			style={accent}
			aria-labelledby={titleId}
			onSubmit={(event) => {
				event.preventDefault();
				if (dirty && !saving) save();
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
									prompt: props.prompt,
								}),
							);
						}}
					>
						{t("Suggest from role")}
					</button>
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
							if (dirty) setLeaving({ kind: "cancel" });
						}}
					>
						{t("Cancel")}
					</button>
					<button type="submit" data-action="save" disabled={!dirty || saving}>
						{saving ? t("Saving…") : t("Save")}
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

const characterLabelBuild = (build: CharacterSpec["build"]) =>
	t(BUILD_LABELS[build]);

/** A class of the grid, drawn on the wearer's current colors. */
function ClassTile(props: {
	id: ClassId;
	base: CharacterSpec;
	pressed: boolean;
	onPick(): void;
}) {
	const colors = props.base.colors;
	const spec = useMemo(
		() => resolveCharacter({ class: props.id, colors }),
		[props.id, colors],
	);
	return (
		<Tile
			data={{ "data-class": props.id }}
			spec={spec}
			size={56}
			label={characterLabel("class", props.id)}
			hint={characterJobs(props.id)}
			pressed={props.pressed}
			onPick={props.onPick}
		/>
	);
}
