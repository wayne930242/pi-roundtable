import {
	lazy,
	Suspense,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import type { AgentPatch, AgentProfileView } from "../../src/api-types.ts";
import {
	closeAgentSheet,
	currentAgentSheet,
	useAgentSheet,
} from "../lib/agent-sheet.ts";
import { api, messageOf } from "../lib/api.ts";
import { useSelector } from "../lib/app-store.ts";
import { useRoomState } from "../lib/characters.ts";
import { type DiffLine, diffCounts, lineDiff } from "../lib/diff.ts";
import { translate as t, wording } from "../lib/messages.ts";
import { setRoomMuted } from "../lib/mute.ts";
import { toast } from "../lib/toast.ts";
import { PageCharacter } from "./character.tsx";
import { Icon } from "./icons.tsx";
import { Sheet } from "./sheet.tsx";
import { Failure, Loading } from "./states.tsx";
import { Switch } from "./switch.tsx";

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
	default: wording("Follow the assistant (automatic)"),
	off: wording("Off"),
	minimal: wording("Minimal"),
	low: wording("Low"),
	medium: wording("Medium"),
	high: wording("High"),
	xhigh: wording("Very high"),
};
const DEFAULT = "default";

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
			title={t("Edit agent")}
			size="wide"
			onClose={closeAgentSheet}
		>
			<AgentEditor key={shown.name} name={shown.name} />
		</Sheet>
	);
}

/** One agent's name, prompt, model, thinking and look, and whether its room is pushed. */
function AgentEditor({ name }: { name: string }) {
	const [profile, setProfile] = useState<AgentProfileView>();
	const [models, setModels] = useState<string[]>([]);
	const [error, setError] = useState<string>();
	const [draft, setDraft] = useState<Draft>();
	const [saving, setSaving] = useState(false);
	const [reviewing, setReviewing] = useState(false);
	const [full, setFull] = useState(false);
	// The profile's own picture shows what its room shows.
	const state = useRoomState(profile?.room ?? "");
	const look = useRef<HTMLElement>(null);
	const loaded = profile !== undefined;
	const muted = useSelector(
		(s) => (profile ? s.rooms[profile.room]?.view?.muted === true : false),
		profile?.room ?? "",
	);
	const [muting, setMuting] = useState(false);
	const promptId = useId();
	const nameId = useId();
	const muteId = useId();

	// "Change look" in a menu lands on the creator.
	useEffect(() => {
		if (!loaded || !currentAgentSheet()?.look) return;
		look.current?.scrollIntoView({ block: "start" });
		look.current?.focus({ preventScroll: true });
	}, [loaded]);

	useEffect(() => {
		let current = true;
		Promise.all([api.agent(name), api.models()]).then(
			([profileLoaded, available]) => {
				if (!current) return;
				setProfile(profileLoaded);
				setModels(available.models);
				setDraft(draftOf(profileLoaded));
			},
			(failure) => current && setError(messageOf(failure)),
		);
		return () => {
			current = false;
		};
	}, [name]);

	const patch = useMemo(
		() => (profile && draft ? patchOf(profile, draft) : {}),
		[profile, draft],
	);

	if (error) return <Failure message={error} />;
	if (!profile || !draft) return <Loading />;

	const dirty = Object.keys(patch).length > 0;
	const choices = Array.from(new Set([DEFAULT, ...models, draft.model]));

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
							thinking: profile.effective.thinking,
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
							<button
								type="button"
								className="secondary compact"
								aria-haspopup="dialog"
								onClick={() => setFull(true)}
							>
								<Expand />
								{t("Full screen")}
							</button>
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
							label: model === DEFAULT ? t("Follow the assistant") : model,
						}))}
					/>
					<Chips
						label={t("Thinking")}
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

/** A choice among a few, as chips: the one that is on is pressed. */
function Chips(props: {
	label: string;
	value: string;
	options: readonly { value: string; label: string }[];
	onChange(value: string): void;
}) {
	return (
		<fieldset className="field">
			<legend>{props.label}</legend>
			<div className="option-chips">
				{props.options.map((option) => (
					<button
						key={option.value}
						type="button"
						aria-pressed={option.value === props.value}
						className="option-chip"
						onClick={() => props.onChange(option.value)}
					>
						{option.label}
					</button>
				))}
			</div>
		</fieldset>
	);
}

const DIFF_MARK: Record<DiffLine["kind"], string> = {
	same: " ",
	add: "+",
	del: "−",
};

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
	const lines = useMemo(
		() => lineDiff(profile.prompt, draft.prompt),
		[profile.prompt, draft.prompt],
	);
	const counts = diffCounts(lines);
	const changes: { label: string; before: string; after: string }[] = [];
	if (draft.displayName !== profile.displayName)
		changes.push({
			label: t("Name"),
			before: profile.displayName,
			after: draft.displayName,
		});
	const modelOf = (value: string) =>
		value === DEFAULT ? t("Follow the assistant") : value;
	if (draft.model !== (profile.model ?? DEFAULT))
		changes.push({
			label: t("Model"),
			before: modelOf(profile.model ?? DEFAULT),
			after: modelOf(draft.model),
		});
	const thinkingOf = (value: string) =>
		t(THINKING_LABELS[value as (typeof THINKING)[number]] ?? value);
	if (draft.thinking !== (profile.thinking ?? DEFAULT))
		changes.push({
			label: t("Thinking"),
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
			<div className="field">
				<span className="field-label">
					{t("Prompt")} ·{" "}
					{t("Lines: {added} added, {removed} removed", {
						added: counts.added,
						removed: counts.removed,
					})}
				</span>
				<pre className="diff">
					{lines.map((line, index) => (
						<span
							// biome-ignore lint/suspicious/noArrayIndexKey: a diff's lines have no identity but their place
							key={index}
							className="diff-line"
							data-kind={line.kind}
						>
							<span className="diff-mark" aria-hidden="true">
								{DIFF_MARK[line.kind]}
							</span>
							{line.kind === "add" || line.kind === "del" ? (
								<span className="visually-hidden">
									{line.kind === "add" ? t("Added") : t("Removed")}:{" "}
								</span>
							) : null}
							{line.text || " "}
						</span>
					))}
				</pre>
			</div>
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
