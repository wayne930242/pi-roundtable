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
	type AgentTab,
	closeAgentSheet,
	currentAgentSheet,
	lastAgentTab,
	rememberAgentTab,
	useAgentSheet,
} from "../lib/agent-sheet.ts";
import { installAgentSheetStyle } from "../lib/agent-sheet-style.ts";
import { api, messageOf } from "../lib/api.ts";
import { useSelector } from "../lib/app-store.ts";
import { useRoomState } from "../lib/characters.ts";
import { editApi } from "../lib/edit-api.ts";
import { translate as t } from "../lib/messages.ts";
import { setRoomMuted } from "../lib/mute.ts";
import { toast } from "../lib/toast.ts";
import {
	AgentFields,
	DEFAULT,
	type FieldsDraft as Draft,
	thinkingOf,
} from "./agent-fields.tsx";
import { AgentMore } from "./agent-more.tsx";
import { defaultModelLabel, Review } from "./agent-review.tsx";
import { Skills } from "./agent-skills.tsx";
import { PageCharacter } from "./character.tsx";
import { Icon } from "./icons.tsx";
import { Sheet } from "./sheet.tsx";
import { Failure, Loading } from "./states.tsx";
import { Switch } from "./switch.tsx";
import { panelId, Tabs, tabId } from "./tabs.tsx";

installAgentSheetStyle();

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
	const tabsId = useId();
	const [tab, setTab] = useState<AgentTab>(
		() => currentAgentSheet()?.tab ?? lastAgentTab(),
	);
	// A panel mounts when it is first shown and stays, so a lazy one loads only if it is asked for.
	const [shown, setShown] = useState<ReadonlySet<AgentTab>>(
		() => new Set([tab]),
	);
	const [noSkills, setNoSkills] = useState(false);
	const [helpers, setHelpers] = useState(false);
	const show = (next: AgentTab) => {
		setTab(next);
		setShown((before) => new Set(before).add(next));
		rememberAgentTab(next);
	};
	useEffect(() => {
		let current = true;
		api.session().then(
			(session) => current && setHelpers(session.helpers === true),
			() => undefined,
		);
		return () => {
			current = false;
		};
	}, []);

	// A tab asked for (Change look, Skills in a menu) is shown; the creator takes the focus once drawn.
	const focusLook = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `opened` is a new ask for the same agent
	useEffect(() => {
		const asked = currentAgentSheet()?.tab;
		if (asked) show(asked);
		focusLook.current = asked === "look";
	}, [opened]);
	const onLook = tab === "look";
	useEffect(() => {
		if (!loaded || !onLook || !focusLook.current || !look.current) return;
		focusLook.current = false;
		look.current.scrollIntoView({ block: "start" });
		look.current.focus({ preventScroll: true });
	});

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

	const tabs = (
		[
			["profile", t("Basics")],
			["skills", t("Skills")],
			["presets", t("Presets")],
			["look", t("Look")],
			["more", t("More")],
		] as const
	)
		.filter(
			([value]) =>
				(value !== "skills" || !noSkills) &&
				(value !== "presets" || (helpers && !profile.helper)),
		)
		.map(([value, label]) => ({ value, label }));
	const on = tabs.some((one) => one.value === tab) ? tab : "profile";
	const panel = (value: AgentTab) => ({
		id: panelId(tabsId, value),
		role: "tabpanel",
		"aria-labelledby": tabId(tabsId, value),
		hidden: on !== value,
		"data-tab": value,
	});
	const mounted = (value: AgentTab) =>
		on === value ||
		(shown.has(value) && tabs.some((one) => one.value === value));

	return (
		<div className="stack agent-sheet">
			<Tabs
				label={t("Edit knight")}
				className="agent-tabs"
				prefix={tabsId}
				value={on}
				tabs={tabs}
				onChange={show}
			/>
			{on === "profile" ? (
				<div className="stack" {...panel("profile")}>
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
				</div>
			) : null}
			{noSkills ? null : (
				<div {...panel("skills")}>
					<Skills
						name={name}
						opened={opened}
						onAbsent={() => setNoSkills(true)}
					/>
				</div>
			)}
			{mounted("presets") ? (
				<div {...panel("presets")}>
					<Suspense fallback={<Loading />}>
						<PresetCard knight={profile} models={models} />
					</Suspense>
				</div>
			) : null}
			{mounted("look") ? (
				<section
					className="card stack"
					ref={look}
					tabIndex={-1}
					{...panel("look")}
				>
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
			) : null}
			{on === "more" ? (
				<div className="stack" {...panel("more")}>
					<AgentMore
						profile={profile}
						coordinator={coordinator}
						onHistory={() => setHistory(true)}
					/>
				</div>
			) : null}
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
