import {
	lazy,
	Suspense,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import type {
	AgentPatch,
	AgentProfileView,
	AgentSkillsView,
} from "../../src/api-types.ts";
import {
	closeAgentSheet,
	currentAgentSheet,
	useAgentSheet,
} from "../lib/agent-sheet.ts";
import { ApiFailure, api, messageOf } from "../lib/api.ts";
import { useSelector } from "../lib/app-store.ts";
import { useRoomState } from "../lib/characters.ts";
import { editApi } from "../lib/edit-api.ts";
import { translate as t } from "../lib/messages.ts";
import { setRoomMuted } from "../lib/mute.ts";
import { askRoomConfirm } from "../lib/room-confirm.ts";
import { teamApi } from "../lib/team-api.ts";
import { toast } from "../lib/toast.ts";
import {
	AgentFields,
	DEFAULT,
	type FieldsDraft as Draft,
	thinkingOf,
} from "./agent-fields.tsx";
import { defaultModelLabel, Review } from "./agent-review.tsx";
import { PageCharacter } from "./character.tsx";
import { Icon } from "./icons.tsx";
import { Sheet } from "./sheet.tsx";
import { SkillPicker } from "./skill-picker.tsx";
import { Failure, Loading } from "./states.tsx";
import { Switch } from "./switch.tsx";

// The history of a prompt is read now and then; it loads when it is asked for.
const HistorySheet = lazy(() =>
	import("./prompt-history.tsx").then((m) => ({ default: m.HistorySheet })),
);

// A knight's temp-knight presets load beside the sheet, so the first page does not carry them.
const PresetCard = lazy(() =>
	import("./preset-sheet.tsx").then((m) => ({ default: m.PresetCard })),
);

// The creator is a page's worth of picking; it loads when the sheet opens.
const CharacterCreator = lazy(() =>
	import("./character-creator.tsx").then((m) => ({
		default: m.CharacterCreator,
	})),
);

const draftOf = (profile: AgentProfileView): Draft => ({
	displayName: profile.displayName,
	prompt: profile.prompt,
	model: profile.model ?? DEFAULT,
	thinking: profile.thinking ?? DEFAULT,
});

/** The fields of the draft that differ from what is saved. */
function patchOf(profile: AgentProfileView, draft: Draft): AgentPatch {
	return {
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
}

/** Draws the sheet that `openAgentSheet` asks for, wherever in the page it was asked. */
export function AgentSheetHost() {
	const ask = useAgentSheet();
	const last = useRef(ask);
	if (ask) last.current = ask;
	const shown = last.current;
	const asked = ask !== undefined;
	// The sheet belongs to the page it was opened on: a step of the history (the system Back) or a new
	// address takes it away, so it never stays over a page it was not opened on.
	useEffect(() => {
		if (!asked) return;
		const at = window.location.href;
		const onMove = () => {
			if (window.location.href !== at) closeAgentSheet();
		};
		window.addEventListener("popstate", onMove);
		window.addEventListener("hashchange", onMove);
		return () => {
			window.removeEventListener("popstate", onMove);
			window.removeEventListener("hashchange", onMove);
		};
	}, [asked]);
	if (!shown) return null;
	return (
		<Sheet
			open={ask !== undefined}
			title={t("Edit knight")}
			size="wide"
			onClose={closeAgentSheet}
		>
			<AgentEditor key={shown.name} name={shown.name} opened={shown.id} />
		</Sheet>
	);
}

/** One agent's name, prompt, model, thinking and look, and whether its room is pushed. */
function AgentEditor({ name, opened }: { name: string; opened: number }) {
	const [profile, setProfile] = useState<AgentProfileView>();
	const [models, setModels] = useState<string[]>([]);
	const [error, setError] = useState<string>();
	const [draft, setDraft] = useState<Draft>();
	const [saving, setSaving] = useState(false);
	const [reviewing, setReviewing] = useState(false);
	const [history, setHistory] = useState(false);
	// The profile's own picture shows what its room shows.
	const state = useRoomState(profile?.room ?? "");
	const look = useRef<HTMLElement>(null);
	const loaded = profile !== undefined;
	const muted = useSelector(
		(s) => (profile ? s.rooms[profile.room]?.view?.muted === true : false),
		profile?.room ?? "",
	);
	const [muting, setMuting] = useState(false);
	// The coordinator is the team's entry and cannot be archived.
	const coordinator = useSelector(
		(s) =>
			profile ? s.rooms[profile.room]?.view?.coordinator === true : false,
		profile?.room ?? "",
	);
	const muteId = useId();

	// "Change look" in a menu lands on the creator.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `opened` is a new ask for the same agent
	useEffect(() => {
		if (!loaded || !currentAgentSheet()?.look) return;
		look.current?.scrollIntoView({ block: "start" });
		look.current?.focus({ preventScroll: true });
	}, [loaded, opened]);

	// Each open reads the profile again, so a save made elsewhere is the base of the diff; a draft with
	// unsaved edits is kept.
	const held = useRef<{ profile?: AgentProfileView; draft?: Draft }>({});
	held.current = { profile, draft };
	// biome-ignore lint/correctness/useExhaustiveDependencies: `opened` is a new ask for the same agent
	useEffect(() => {
		let current = true;
		Promise.all([api.agent(name), api.models()]).then(
			([profileLoaded, available]) => {
				if (!current) return;
				const { profile: before, draft: edited } = held.current;
				const keep =
					before && edited && Object.keys(patchOf(before, edited)).length > 0;
				setProfile(profileLoaded);
				setModels(available.models);
				setDraft(keep ? edited : draftOf(profileLoaded));
			},
			(failure) => current && setError(messageOf(failure)),
		);
		return () => {
			current = false;
		};
	}, [name, opened]);

	const patch = useMemo(
		() => (profile && draft ? patchOf(profile, draft) : {}),
		[profile, draft],
	);

	if (error) return <Failure message={error} />;
	if (!profile || !draft) return <Loading />;

	const dirty = Object.keys(patch).length > 0;

	const save = async () => {
		setSaving(true);
		try {
			const saved = await api.updateAgent(name, patch);
			setProfile(saved);
			setDraft(draftOf(saved));
			setReviewing(false);
			toast(t("Saved."));
		} catch (failure) {
			toast(messageOf(failure), "danger");
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="stack agent-sheet">
			<header className="profile-head">
				<PageCharacter
					spec={profile.character}
					name={profile.name}
					size={72}
					state={state}
					label={profile.displayName}
				/>
				<div>
					<h3>{profile.displayName}</h3>
					<p className="meta">
						{t("Runs on {model}, thinking {thinking}", {
							model: profile.effective.model,
							thinking: thinkingOf(profile.effective.thinking),
						})}
					</p>
				</div>
			</header>
			<ul className="menu">
				<li>
					<label className="menu-item menu-toggle" htmlFor={muteId}>
						<span className="menu-icon">
							<Icon name={muted ? "bell-off" : "bell"} />
						</span>
						<span className="menu-text">
							<strong>{t("Notifications")}</strong>
							<span className="meta">
								{t(
									"Push this room's posts to every owner's devices. A card that waits for you is always pushed.",
								)}
							</span>
						</span>
						<Switch
							id={muteId}
							checked={!muted}
							label={t("Notifications")}
							busy={muting}
							onChange={async (next) => {
								setMuting(true);
								await setRoomMuted(profile.room, !next);
								setMuting(false);
							}}
						/>
					</label>
				</li>
			</ul>
			{reviewing ? (
				<Review
					profile={profile}
					draft={draft}
					saving={saving}
					onBack={() => setReviewing(false)}
					onSave={save}
				/>
			) : (
				<form
					className="stack form"
					onSubmit={(event) => {
						event.preventDefault();
						if (!dirty) return;
						// A prompt shapes everything the agent does: it is read over once before it is saved.
						if (patch.prompt !== undefined) setReviewing(true);
						else save();
					}}
				>
					<AgentFields
						draft={draft}
						onChange={setDraft}
						models={models}
						defaultModel={defaultModelLabel(profile)}
						onHistory={() => setHistory(true)}
					/>
					<div className="actions">
						<button type="submit" disabled={!dirty || saving}>
							{saving
								? t("Saving…")
								: patch.prompt !== undefined
									? t("Review changes")
									: t("Save")}
						</button>
					</div>
				</form>
			)}
			<Skills name={name} opened={opened} />
			{profile.helper ? null : (
				<Suspense fallback={null}>
					<PresetCard agent={name} models={models} />
				</Suspense>
			)}
			<section className="card stack" ref={look} tabIndex={-1}>
				<h3>{t("Look")}</h3>
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
			{coordinator ? null : (
				<section className="card stack">
					<h3>{t("Archive")}</h3>
					<p className="meta">
						{t(
							"An archived knight stops answering and its schedules are cancelled. Its history is kept, and you can restore it from Archived.",
						)}
					</p>
					<div className="actions">
						<button
							type="button"
							className="danger"
							onClick={() => {
								closeAgentSheet();
								askRoomConfirm({
									kind: "archive",
									room: profile.room,
									name: profile.displayName,
								});
							}}
						>
							{t("Archive {name}", { name: profile.displayName })}
						</button>
					</div>
				</section>
			)}
			{history ? (
				<Suspense fallback={null}>
					<HistorySheet
						open={history}
						title={t("History of the prompt")}
						load={async () =>
							(await editApi.agentPromptHistory(name)).versions.map((v) => ({
								id: v.id,
								text: v.text,
								previous: v.previous,
								by: v.by,
								at: v.at,
							}))
						}
						onUse={(text) => {
							setDraft({ ...draft, prompt: text });
							setHistory(false);
						}}
						onClose={() => setHistory(false)}
					/>
				</Suspense>
			) : null}
		</div>
	);
}

/**
 * The skills the agent carries, from the host's catalog: a switch each, applied as it is flipped.
 * The built-in ones are carried by every agent and stay on. A host without skills shows nothing.
 */
function Skills({ name, opened }: { name: string; opened: number }) {
	const [view, setView] = useState<AgentSkillsView>();
	const [busy, setBusy] = useState<string>();
	const [error, setError] = useState<string>();
	const section = useRef<HTMLElement>(null);
	const loaded = view !== undefined;
	// "Skills" in a menu lands here once the list has come.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `opened` is a new ask for the same agent
	useEffect(() => {
		if (!loaded || !currentAgentSheet()?.skills) return;
		section.current?.scrollIntoView({ block: "start" });
		section.current?.focus({ preventScroll: true });
	}, [loaded, opened]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `opened` is a new ask for the same agent
	useEffect(() => {
		let current = true;
		teamApi.skills(name).then(
			(loaded) => current && setView(loaded),
			(failure) => {
				// The host has no skills addon: there is nothing to choose.
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
	}, [name, opened]);
	if (error) return <Failure message={error} />;
	if (!view) return null;
	const reread = () =>
		teamApi.skills(name).then(setView, (failure) => {
			toast(messageOf(failure), "danger");
		});
	const flip = async (skill: string, next: boolean) => {
		setBusy(skill);
		try {
			setView(
				await teamApi.setSkills(
					name,
					next ? { add: [skill] } : { remove: [skill] },
				),
			);
		} catch (failure) {
			toast(messageOf(failure), "danger");
		} finally {
			setBusy(undefined);
		}
	};
	return (
		<section
			className="card stack"
			aria-label={t("Skills")}
			ref={section}
			tabIndex={-1}
		>
			<h3>
				{t("Skills ({count})", {
					count: view.skills.filter((skill) => skill.carried).length,
				})}
			</h3>
			<p className="meta">
				{t(
					"What the knight can load when a task calls for it. It applies from its next turn.",
				)}
			</p>
			<SkillPicker
				skills={view.skills}
				who={name}
				busy={busy}
				onFlip={flip}
				onApplyGroup={async (group, on) => {
					const applied = await editApi.applySkillGroup(group.name, name, on);
					reread();
					return applied;
				}}
			/>
		</section>
	);
}
