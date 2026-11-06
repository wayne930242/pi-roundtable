import type { CharacterInput, CharacterSpec } from "pi-roundtable/characters";
import { lazy, Suspense } from "react";
import { translate as t } from "../lib/messages.ts";
import { PageCharacter } from "./character.tsx";
import { Loading } from "./states.tsx";

// The creator is a page's worth of picking; it loads when a look is first chosen.
const CharacterCreator = lazy(() =>
	import("./character-creator.tsx").then((m) => ({
		default: m.CharacterCreator,
	})),
);

/**
 * The look of a knight not made yet, as a form shows it: the picture, whether it is a chosen look or
 * the one its role suggests, and the button that opens `LookCreator` to choose another.
 */
export function LookSummary(props: {
	spec: CharacterSpec;
	name: string;
	displayName: string;
	chosen: boolean;
	onChoose(): void;
}) {
	return (
		<div className="profile-head">
			<PageCharacter
				spec={props.spec}
				name={props.name}
				size={72}
				label={props.displayName}
			/>
			<div>
				<strong>{t("Look")}</strong>
				<span className="meta">
					{props.chosen ? t("Your look") : t("Suggested from its role")}
				</span>
				<button
					type="button"
					className="secondary compact"
					onClick={props.onChoose}
				>
					{t("Choose a look")}
				</button>
			</div>
		</div>
	);
}

/** The character creator in its picking mode, which saves nothing: the form keeps the look it hands back. */
export function LookCreator(props: {
	spec: CharacterSpec;
	name: string;
	displayName: string;
	prompt: string;
	onPick(look: CharacterInput, spec: CharacterSpec): void;
	onCancel(): void;
}) {
	return (
		<Suspense fallback={<Loading />}>
			<CharacterCreator
				name={props.name}
				displayName={props.displayName}
				prompt={props.prompt}
				character={props.spec}
				onPick={props.onPick}
				onCancel={props.onCancel}
			/>
		</Suspense>
	);
}
