import { lazy, Suspense, useMemo, useState } from "react";
import type { ProfileView } from "../../src/api-types.ts";
import { PageCharacter } from "../components/character.tsx";
import { Confirm } from "../components/confirm.tsx";
import { Loading } from "../components/states.tsx";
import { accountApi } from "../lib/account-api.ts";
import { store } from "../lib/app-store.ts";
import { suggestionFor } from "../lib/character-spec.ts";
import { useKit } from "../lib/kit.ts";
import { translate as t } from "../lib/messages.ts";

// The creator is a page's worth of picking; it loads when the person first designs their knight.
const CharacterCreator = lazy(() =>
	import("../components/character-creator.tsx").then((m) => ({
		default: m.CharacterCreator,
	})),
);

/** A profile the server answered: its knight is the one the app draws the person with from now on. */
export function tookProfile(view: ProfileView): ProfileView {
	store.dispatch({ type: "knight", character: view.character });
	return view;
}

/**
 * The person's own knight on their profile: the way to design one, or the knight with the ways to
 * change it and to go back to the account picture.
 */
export function KnightCard(props: {
	profile: ProfileView;
	changed(view: ProfileView): void;
	onDesign(): void;
}) {
	const { character, principal, name } = props.profile;
	const [removing, setRemoving] = useState(false);
	return (
		<section className="card stack knight-card">
			<h2>{t("Your knight")}</h2>
			<p className="meta">
				{t(
					"Your knight stands in for your picture on the home and beside your messages.",
				)}
			</p>
			{character ? (
				<div className="profile-head">
					<PageCharacter
						spec={character}
						name={principal}
						size={96}
						label={name}
					/>
					<div>
						<button type="button" onClick={props.onDesign}>
							{t("Change look")}
						</button>
						<button
							type="button"
							className="secondary"
							onClick={() => setRemoving(true)}
						>
							{t("Remove, back to the picture")}
						</button>
					</div>
				</div>
			) : (
				<div className="actions">
					<button type="button" onClick={props.onDesign}>
						{t("Design my knight")}
					</button>
				</div>
			)}
			<Confirm
				open={removing}
				title={t("Remove your knight?")}
				confirmLabel={t("Remove")}
				tone="danger"
				onClose={() => setRemoving(false)}
				onConfirm={async () =>
					props.changed(tookProfile(await accountApi.removeCharacter()))
				}
			>
				<p>
					{t(
						"Your account picture shows again. You can design a knight again later.",
					)}
				</p>
			</Confirm>
		</section>
	);
}

/**
 * The creator for the person's own knight, in place of the profile page. It starts from their
 * knight, or from the look their id suggests, which is what the server starts from too.
 */
export function KnightCreator(props: {
	profile: ProfileView;
	/** The person saved (the profile as it is now) or left without saving. */
	done(view?: ProfileView): void;
}) {
	const { profile } = props;
	const kit = useKit();
	const start = useMemo(
		() =>
			profile.character ??
			(kit
				? suggestionFor(kit, {
						name: profile.principal,
						displayName: profile.name,
					})
				: undefined),
		[kit, profile.character, profile.principal, profile.name],
	);
	if (!start) return <Loading />;
	return (
		<Suspense fallback={<Loading />}>
			<CharacterCreator
				name={profile.principal}
				displayName={profile.name}
				character={start}
				fresh={!profile.character}
				save={async (look) =>
					props.done(tookProfile(await accountApi.setCharacter(look)))
				}
				onCancel={() => props.done()}
			/>
		</Suspense>
	);
}
