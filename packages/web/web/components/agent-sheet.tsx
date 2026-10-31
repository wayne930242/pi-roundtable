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
	SkillGroupView,
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
import { translate as t, wording } from "../lib/messages.ts";
import { setRoomMuted } from "../lib/mute.ts";
import { askRoomConfirm } from "../lib/room-confirm.ts";
import { teamApi } from "../lib/team-api.ts";
import { toast } from "../lib/toast.ts";
import { PageCharacter } from "./character.tsx";
import { Chips } from "./chips.tsx";
import { Confirm } from "./confirm.tsx";
import { TextDiff } from "./diff-block.tsx";
import { Icon } from "./icons.tsx";
import { Sheet } from "./sheet.tsx";
import { Failure, Loading } from "./states.tsx";
import { Switch } from "./switch.tsx";

// The history of a prompt is read now and then; it loads when it is asked for.
const HistorySheet = lazy(() =>
	import("./prompt-history.tsx").then((m) => ({ default: m.HistorySheet })),
);

// The creator is a page's worth of picking; it loads when the sheet opens.
const CharacterCreator = lazy(() =>
	import("./character-creator.tsx").then((m) => ({
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
] as const;
const THINKING_LABELS: Record<(typeof THINKING)[number], string> = {
	default: wording("Default"),
	off: wording("Off"),
	minimal: wording("Minimal"),
	low: wording("Low"),
	medium: wording("Medium"),
	high: wording("High"),
	xhigh: wording("Very high"),
};
const DEFAULT = "default";
/** The select's "no model chosen" row: the resolved model when this page knows it, else the server setting. */
const defaultModelLabel = (profile: AgentProfileView) =>
	profile.model === undefined
		? t("Default model ({current})", { current: profile.effective.model })
		: t("Default model (server setting)");
/** The resolved level the profile line shows: a setting, or `auto` when the model picks. */
const AUTOMATIC = wording("Automatic");
const thinkingOf = (value: string) =>
	value === "auto"
		? t(AUTOMATIC)
		: t(THINKING_LABELS[value as (typeof THINKING)[number]] ?? value);

interface Draft {
	displayName: string;
	prompt: string;
	model: string;
	thinking: string;
}

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
	const [full, setFull] = useState(false);
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
	const promptId = useId();
	const nameId = useId();
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
	const choices = Array.from(new Set([DEFAULT, ...models, draft.model]));
	const defaultModel = defaultModelLabel(profile);

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
					<label htmlFor={nameId}>
						{t("Name")}
						<input
							id={nameId}
							value={draft.displayName}
							onChange={(event) =>
								setDraft({ ...draft, displayName: event.target.value })
							}
						/>
					</label>
					<div className="field">
						<div className="field-head">
							<label htmlFor={promptId}>{t("Prompt")}</label>
							<span className="field-tools">
								<button
									type="button"
									className="secondary compact"
									aria-haspopup="dialog"
									onClick={() => setHistory(true)}
								>
									<Icon name="reset" size={16} />
									{t("History")}
								</button>
								<button
									type="button"
									className="secondary compact"
									aria-haspopup="dialog"
									onClick={() => setFull(true)}
								>
									<Expand />
									{t("Full screen")}
								</button>
							</span>
						</div>
						<textarea
							id={promptId}
							rows={8}
							value={draft.prompt}
							onChange={(event) =>
								setDraft({ ...draft, prompt: event.target.value })
							}
						/>
					</div>
					<Chips
						label={t("Model")}
						value={draft.model}
						onChange={(model) => setDraft({ ...draft, model })}
						options={choices.map((model) => ({
							value: model,
							label: model === DEFAULT ? defaultModel : model,
						}))}
					/>
					<Chips
						label={t("Thinking level")}
						value={draft.thinking}
						onChange={(thinking) => setDraft({ ...draft, thinking })}
						options={THINKING.map((level) => ({
							value: level,
							label: t(THINKING_LABELS[level]),
						}))}
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
			<Sheet
				open={full}
				title={t("Prompt")}
				size="full"
				onClose={() => setFull(false)}
			>
				<textarea
					className="prompt-full"
					aria-label={t("Prompt")}
					value={draft.prompt}
					onChange={(event) =>
						setDraft({ ...draft, prompt: event.target.value })
					}
				/>
			</Sheet>
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
	const prefix = useId();
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
			<ul className="menu">
				{view.skills.map((skill, index) => {
					const id = `${prefix}-${index}`;
					return (
						<li key={skill.name}>
							<label className="menu-item menu-toggle" htmlFor={id}>
								<span className="menu-text">
									<strong>{skill.name}</strong>
									<span className="meta">
										{skill.missing
											? t("Its file cannot be read.")
											: skill.builtin
												? t("Built in: every knight carries it.")
												: (skill.description ?? "")}
									</span>
								</span>
								<Switch
									id={id}
									checked={skill.carried}
									label={skill.name}
									busy={busy === skill.name}
									disabled={skill.builtin}
									onChange={(next) => flip(skill.name, next)}
								/>
							</label>
						</li>
					);
				})}
			</ul>
			<ApplyGroup name={name} view={view} onApplied={reread} />
		</section>
	);
}

/**
 * A switch per skill group: on, after a confirmation, switches on the group's skills the knight lacks;
 * off switches off the group's skills it carries, built-in ones excepted. A group shows on when the
 * knight carries all of it. The knight carries the skills, not the group. A host without groups, or an
 * app without them, shows nothing.
 */
function ApplyGroup({
	name,
	view,
	onApplied,
}: {
	name: string;
	view: AgentSkillsView;
	onApplied(): void;
}) {
	const [groups, setGroups] = useState<SkillGroupView[]>();
	const [pending, setPending] = useState<{
		group: SkillGroupView;
		on: boolean;
	}>();
	const prefix = useId();
	useEffect(() => {
		let current = true;
		editApi.skillGroups().then(
			(loaded) => current && setGroups(loaded.groups),
			() => undefined,
		);
		return () => {
			current = false;
		};
	}, []);
	if (!groups?.length) return null;
	const carried = new Set(
		view.skills.filter((skill) => skill.carried).map((skill) => skill.name),
	);
	const locked = new Set(
		view.skills.filter((skill) => skill.builtin).map((skill) => skill.name),
	);
	const lacking = (group: SkillGroupView) =>
		group.skills.filter((skill) => !carried.has(skill));
	const dropping = (group: SkillGroupView) =>
		group.skills.filter((skill) => carried.has(skill) && !locked.has(skill));
	return (
		<div className="stack skill-apply">
			<h4>{t("Skill groups")}</h4>
			<p className="meta">
				{t(
					"Switching a group on switches on its skills this knight lacks; switching it off switches off its skills, built-in ones excepted.",
				)}
			</p>
			<ul className="menu">
				{groups.map((group, index) => {
					const missing = lacking(group);
					const on = missing.length === 0;
					return (
						<li key={group.name}>
							<label
								className="menu-item menu-toggle"
								htmlFor={`${prefix}-group-${index}`}
							>
								<span className="menu-text">
									<strong>{group.name}</strong>
									<span className="meta">
										{on
											? t("Carries all of it.")
											: t("Lacks {count}: {skills}", {
													count: missing.length,
													skills: missing.join(", "),
												})}
									</span>
								</span>
								<Switch
									id={`${prefix}-group-${index}`}
									checked={on}
									label={t("Skill group {name}", { name: group.name })}
									disabled={on && dropping(group).length === 0}
									onChange={(next) => setPending({ group, on: next })}
								/>
							</label>
						</li>
					);
				})}
			</ul>
			<Confirm
				open={pending !== undefined}
				title={
					pending?.on
						? t("Switch this skill group on?")
						: t("Switch this skill group off?")
				}
				confirmLabel={pending?.on ? t("Switch on") : t("Switch off")}
				tone={pending?.on ? "primary" : "danger"}
				onClose={() => setPending(undefined)}
				onConfirm={async () => {
					if (!pending) return;
					const { added, removed } = await editApi.applySkillGroup(
						pending.group.name,
						name,
						pending.on,
					);
					toast(
						added.length
							? t("Switched on: {skills}", { skills: added.join(", ") })
							: removed.length
								? t("Switched off: {skills}", { skills: removed.join(", ") })
								: t("Nothing changed for {name}.", {
										name: pending.group.name,
									}),
					);
					onApplied();
				}}
			>
				<p>
					{pending
						? pending.on
							? t("{agent} will also carry: {skills}.", {
									agent: name,
									skills: lacking(pending.group).join(", "),
								})
							: t("{agent} will no longer carry: {skills}.", {
									agent: name,
									skills: dropping(pending.group).join(", "),
								})
						: null}
				</p>
			</Confirm>
		</div>
	);
}

/** The corners of a window: the prompt opens as large as the window. Drawn here, as only this sheet uses it. */
const Expand = () => (
	<svg
		viewBox="0 0 24 24"
		width={16}
		height={16}
		fill="none"
		stroke="currentColor"
		strokeWidth={1.8}
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
		focusable="false"
	>
		<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
	</svg>
);

/** What a save would change, read over once: the changed fields, and the prompt line by line. */
function Review(props: {
	profile: AgentProfileView;
	draft: Draft;
	saving: boolean;
	onBack(): void;
	onSave(): void;
}) {
	const { profile, draft } = props;
	const root = useRef<HTMLElement>(null);
	// The form's button that opened the review is gone; the keyboard continues from the review.
	useEffect(() => root.current?.focus(), []);
	const changes: { label: string; before: string; after: string }[] = [];
	if (draft.displayName !== profile.displayName)
		changes.push({
			label: t("Name"),
			before: profile.displayName,
			after: draft.displayName,
		});
	const modelOf = (value: string) =>
		value === DEFAULT ? defaultModelLabel(profile) : value;
	if (draft.model !== (profile.model ?? DEFAULT))
		changes.push({
			label: t("Model"),
			before: modelOf(profile.model ?? DEFAULT),
			after: modelOf(draft.model),
		});
	if (draft.thinking !== (profile.thinking ?? DEFAULT))
		changes.push({
			label: t("Thinking level"),
			before: thinkingOf(profile.thinking ?? DEFAULT),
			after: thinkingOf(draft.thinking),
		});
	return (
		<section
			ref={root}
			className="stack review"
			tabIndex={-1}
			aria-label={t("Review changes")}
		>
			<h3>{t("Review changes")}</h3>
			{changes.length ? (
				<ul className="review-fields">
					{changes.map((change) => (
						<li key={change.label}>
							<strong>{change.label}</strong>
							<span className="review-before">{change.before}</span>
							<span aria-hidden="true">→</span>
							<span className="review-after">{change.after}</span>
						</li>
					))}
				</ul>
			) : null}
			<TextDiff
				label={t("Prompt")}
				before={profile.prompt}
				after={draft.prompt}
			/>
			<div className="actions">
				<button
					type="button"
					className="secondary"
					disabled={props.saving}
					onClick={props.onBack}
				>
					{t("Back to editing")}
				</button>
				<button type="button" disabled={props.saving} onClick={props.onSave}>
					{props.saving ? t("Saving…") : t("Save")}
				</button>
			</div>
		</section>
	);
}
