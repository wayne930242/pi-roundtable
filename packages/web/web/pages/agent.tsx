import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { AgentPatch, AgentProfileView } from "../../src/api-types.ts";
import { PageCharacter } from "../components/character.tsx";
import { Icon } from "../components/icons.tsx";
import { Failure, Loading } from "../components/states.tsx";
import { takeLook } from "../lib/agent-focus.ts";
import { api, messageOf } from "../lib/api.ts";
import { useRoomState } from "../lib/characters.ts";
import { translate as t } from "../lib/messages.ts";
import { hrefFor } from "../lib/router.ts";
import { toast } from "../lib/toast.ts";

// The creator is a page's worth of picking; it loads when the profile opens.
const CharacterCreator = lazy(() =>
	import("../components/character-creator.tsx").then((m) => ({
		default: m.CharacterCreator,
	})),
);

/** What a thinking setting may be. `default` follows the assistant's, which is automatic. */
const THINKING = [
	"default",
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];
const DEFAULT = "default";

/** One agent's profile: its name, prompt, model and thinking, and its picture. */
export function AgentPage({ name }: { name: string }) {
	const [profile, setProfile] = useState<AgentProfileView>();
	const [models, setModels] = useState<string[]>([]);
	const [error, setError] = useState<string>();
	const [draft, setDraft] = useState<{
		displayName: string;
		prompt: string;
		model: string;
		thinking: string;
	}>();
	const [saving, setSaving] = useState(false);
	// The profile's own picture shows what its room shows.
	const state = useRoomState(profile?.room ?? "");
	const look = useRef<HTMLElement>(null);
	const loaded = profile !== undefined;

	// "Change look" in a room's menu lands on the creator.
	useEffect(() => {
		if (!loaded || !takeLook()) return;
		look.current?.scrollIntoView({ block: "start" });
		look.current?.focus({ preventScroll: true });
	}, [loaded]);

	useEffect(() => {
		let current = true;
		Promise.all([api.agent(name), api.models()]).then(
			([loaded, available]) => {
				if (!current) return;
				setProfile(loaded);
				setModels(available.models);
				setDraft({
					displayName: loaded.displayName,
					prompt: loaded.prompt,
					model: loaded.model ?? DEFAULT,
					thinking: loaded.thinking ?? DEFAULT,
				});
			},
			(failure) => current && setError(messageOf(failure)),
		);
		return () => {
			current = false;
		};
	}, [name]);

	if (error)
		return (
			<div className="page">
				<Failure message={error} />
			</div>
		);
	if (!profile || !draft)
		return (
			<div className="page">
				<Loading />
			</div>
		);

	const choices = Array.from(new Set([DEFAULT, ...models, draft.model]));
	const patch: AgentPatch = {
		...(draft.displayName !== profile.displayName
			? { displayName: draft.displayName }
			: {}),
		...(draft.prompt !== profile.prompt ? { prompt: draft.prompt } : {}),
		...(draft.model !== (profile.model ?? DEFAULT)
			? { model: draft.model }
			: {}),
		...(draft.thinking !== (profile.thinking ?? DEFAULT)
			? { thinking: draft.thinking }
			: {}),
	};
	const dirty = Object.keys(patch).length > 0;

	const save = async () => {
		setSaving(true);
		try {
			const saved = await api.updateAgent(name, patch);
			setProfile(saved);
			setDraft({
				displayName: saved.displayName,
				prompt: saved.prompt,
				model: saved.model ?? DEFAULT,
				thinking: saved.thinking ?? DEFAULT,
			});
			toast(t("Saved."));
		} catch (failure) {
			toast(messageOf(failure), "danger");
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="page">
			<header className="page-bar">
				<a
					className="icon-button"
					href={hrefFor("room", profile.room)}
					aria-label={t("Back to the room")}
				>
					<Icon name="back" />
				</a>
				<strong>{t("Profile")}</strong>
			</header>
			<header className="profile-head">
				<PageCharacter
					spec={profile.character}
					name={profile.name}
					size={72}
					state={state}
					label={profile.displayName}
				/>
				<div>
					<h1>{profile.displayName}</h1>
					<p className="meta">
						{t("Runs on {model}, thinking {thinking}", {
							model: profile.effective.model,
							thinking: profile.effective.thinking,
						})}
					</p>
				</div>
			</header>
			<section className="card stack" ref={look} tabIndex={-1}>
				<h2>{t("Look")}</h2>
				<p className="meta">
					{t(
						"Class, colors and parts. The picture here, in the rooms and in Discord all follow it.",
					)}
				</p>
				<Suspense fallback={<Loading />}>
					<CharacterCreator
						name={profile.name}
						displayName={profile.displayName}
						prompt={profile.prompt}
						character={profile.character}
						onSaved={(saved) => setProfile(saved)}
					/>
				</Suspense>
			</section>
			<form
				className="stack form"
				onSubmit={(event) => {
					event.preventDefault();
					if (dirty) save();
				}}
			>
				<label>
					{t("Name")}
					<input
						value={draft.displayName}
						onChange={(event) =>
							setDraft({ ...draft, displayName: event.target.value })
						}
					/>
				</label>
				<label>
					{t("Prompt")}
					<textarea
						rows={10}
						value={draft.prompt}
						onChange={(event) =>
							setDraft({ ...draft, prompt: event.target.value })
						}
					/>
				</label>
				<div className="form-row">
					<label>
						{t("Model")}
						<select
							value={draft.model}
							onChange={(event) =>
								setDraft({ ...draft, model: event.target.value })
							}
						>
							{choices.map((model) => (
								<option key={model} value={model}>
									{model === DEFAULT ? t("Follow the assistant") : model}
								</option>
							))}
						</select>
					</label>
					<label>
						{t("Thinking")}
						<select
							value={draft.thinking}
							onChange={(event) =>
								setDraft({ ...draft, thinking: event.target.value })
							}
						>
							{THINKING.map((level) => (
								<option key={level} value={level}>
									{level === DEFAULT
										? t("Follow the assistant (automatic)")
										: level}
								</option>
							))}
						</select>
					</label>
				</div>
				<div className="actions">
					<button type="submit" disabled={!dirty || saving}>
						{saving ? t("Saving…") : t("Save")}
					</button>
				</div>
			</form>
		</div>
	);
}
