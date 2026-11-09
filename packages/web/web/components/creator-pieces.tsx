import {
	type CharacterSpec,
	type ClassId,
	resolveCharacter,
} from "pi-roundtable/characters";
import {
	memo,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	characterJobs,
	characterLabel,
	type LabelKind,
} from "../lib/character-labels.ts";
import { PageCharacter } from "./character.tsx";
import type { PARTS, PartField } from "./creator-parts.ts";

/** One choice of a strip or grid: a small drawing and its name. */
export const Tile = memo(function Tile(props: {
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

/**
 * Which ends of a row that scrolls sideways have more of it beyond them, so the row can fade there and
 * a person sees that it goes on: `start` (more to the left), `end`, `both`, or nothing when it fits.
 */
function useScrollCue(): [
	React.RefObject<HTMLDivElement | null>,
	"start" | "end" | "both" | undefined,
] {
	const row = useRef<HTMLDivElement>(null);
	const [cue, setCue] = useState<"start" | "end" | "both" | undefined>();
	useEffect(() => {
		const element = row.current;
		if (!element) return;
		const measure = () => {
			const before = element.scrollLeft > 1;
			const after =
				element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
			setCue(
				before && after ? "both" : after ? "end" : before ? "start" : undefined,
			);
		};
		measure();
		element.addEventListener("scroll", measure, { passive: true });
		const watch =
			typeof ResizeObserver === "undefined"
				? undefined
				: new ResizeObserver(measure);
		watch?.observe(element);
		return () => {
			element.removeEventListener("scroll", measure);
			watch?.disconnect();
		};
	}, []);
	return [row, cue];
}

export function Strip(props: {
	part: (typeof PARTS)[number];
	draft: CharacterSpec;
	shown: CharacterSpec;
	onPick(id: string): void;
}) {
	const { part } = props;
	const previews = usePreviews(props.shown, part.field, part.ids);
	const [row, cue] = useScrollCue();
	return (
		<div className="creator-strip" ref={row} data-more={cue}>
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
export function Swatch(props: {
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

export function Field(props: {
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

/** A class of the grid, drawn on the wearer's current colors. */
export function ClassTile(props: {
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
