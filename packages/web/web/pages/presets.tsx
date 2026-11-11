import { useEffect, useState } from "react";
import type {
	PresetOverviewView,
	PresetView,
	SessionView,
} from "../../src/api-types.ts";
import { PageCharacter } from "../components/character.tsx";
import { Select } from "../components/fields.tsx";
import { Icon } from "../components/icons.tsx";
import { useKnights } from "../components/knight-picker.tsx";
import { PresetSheet } from "../components/preset-editor.tsx";
import {
	PickKnight,
	PresetRow,
	recruitSummary,
} from "../components/preset-parts.tsx";
import { SearchField } from "../components/search-field.tsx";
import { Empty, Failure, Loading } from "../components/states.tsx";
import { api } from "../lib/api.ts";
import { useCharacters } from "../lib/characters.ts";
import { installStyle } from "../lib/lazy-style.ts";
import { plural, translate as t } from "../lib/messages.ts";
import { teamApi } from "../lib/team-api.ts";
import { useFetched } from "../lib/use-fetched.ts";

/** What the page has open: a knight's preset, or a new one for the knight chosen. */
type Opened = { agent: string; preset?: PresetOverviewView };

/** Who besides its knight may recruit from a preset, in a few words. */
const sharingOf = (preset: PresetView, owner: string): string =>
	preset.sharedWith === "all"
		? t("All knights")
		: preset.sharedWith?.length
			? plural(preset.sharedWith.length, "{count} knight", "{count} knights")
			: t("Only {name}", { name: owner });

/**
 * Every knight's temp-knight presets, grouped by the knight they belong to: whom each is shared
 * with and who recruited from it. A row opens the same preset sheet as the knight's own sheet.
 */
const PRESETS_CSS = `
.preset-owner {
	display: flex;
	align-items: center;
	gap: var(--space-2);
}
`;

export default function PresetsPage() {
	installStyle("presets-page", PRESETS_CSS);
	const [session, setSession] = useState<SessionView>();
	const [models, setModels] = useState<readonly string[]>([]);
	const [version, setVersion] = useState(0);
	const [query, setQuery] = useState("");
	const [owner, setOwner] = useState("");
	const [choosing, setChoosing] = useState(false);
	const [opened, setOpened] = useState<Opened>();
	const knights = useKnights();
	const characters = useCharacters();
	useEffect(() => {
		api.session().then(setSession, () => setSession(undefined));
		api.models().then(
			(loaded) => setModels(loaded.models),
			() => undefined,
		);
	}, []);
	const helpers = session?.helpers === true;
	const { data, error } = useFetched(
		() =>
			helpers ? teamApi.allPresets() : Promise.resolve({ presets: [], max: 0 }),
		`presets:${helpers}:${version}`,
	);
	const nameOf = (name: string) =>
		knights.find((one) => one.name === name)?.displayName ?? name;
	const words = query.trim().toLowerCase();
	const shown = (data?.presets ?? []).filter(
		(preset) =>
			(!owner || preset.agent === owner) &&
			(!words ||
				[preset.name, preset.displayName, nameOf(preset.agent)].some((text) =>
					text.toLowerCase().includes(words),
				)),
	);
	const owners = [...new Set((data?.presets ?? []).map((p) => p.agent))];
	const groups = [...new Set(shown.map((p) => p.agent))];
	const reload = () => setVersion((n) => n + 1);
	const close = () => {
		setOpened(undefined);
		reload();
	};
	return (
		<section className="page stack" data-presets-page="">
			<div className="card-head">
				<h2>{t("Presets")}</h2>
				{helpers ? (
					<button
						type="button"
						className="secondary"
						onClick={() => setChoosing(true)}
					>
						<Icon name="plus" size={16} />
						{t("New preset")}
					</button>
				) : null}
			</div>
			{session && !helpers ? (
				<Empty>{t("Temp knights are off on this host.")}</Empty>
			) : null}
			{error ? <Failure message={error} /> : null}
			{helpers && !data && !error ? <Loading /> : null}
			{helpers && data?.presets.length === 0 ? (
				<Empty>{t("No presets yet.")}</Empty>
			) : null}
			{helpers && owners.length > 0 ? (
				<div className="actions">
					<SearchField
						label={t("Search {name}", { name: t("Presets") })}
						value={query}
						onChange={setQuery}
					/>
					<Select
						aria-label={t("Knight")}
						value={owner}
						onChange={(event) => setOwner(event.target.value)}
					>
						<option value="">{t("All knights")}</option>
						{owners.map((name) => (
							<option key={name} value={name}>
								{nameOf(name)}
							</option>
						))}
					</Select>
				</div>
			) : null}
			{groups.map((agent) => (
				<article key={agent} className="card stack" data-owner={agent}>
					<div className="preset-owner">
						<PageCharacter
							spec={characters[agent]}
							name={agent}
							size={32}
							live={false}
						/>
						<strong>{nameOf(agent)}</strong>
					</div>
					<ul className="menu">
						{shown
							.filter((preset) => preset.agent === agent)
							.map((preset) => (
								<PresetRow
									key={preset.name}
									preset={preset}
									meta={[
										t("Skills ({count})", { count: preset.skills.length }),
										sharingOf(preset, nameOf(agent)),
										recruitSummary(preset.recruits),
									].join(" · ")}
									data={{ "data-preset": `${agent}/${preset.name}` }}
									onOpen={() => setOpened({ agent, preset })}
								/>
							))}
					</ul>
				</article>
			))}
			<PickKnight
				open={choosing}
				title={t("Which knight it belongs to")}
				confirmLabel={t("Continue")}
				onClose={() => setChoosing(false)}
				onPick={async (agent) => setOpened({ agent })}
			/>
			{opened ? (
				<PresetSheet
					key={`${opened.agent}/${opened.preset?.name ?? ""}`}
					agent={opened.agent}
					agentName={nameOf(opened.agent)}
					{...(opened.preset
						? { preset: opened.preset, recruits: opened.preset.recruits }
						: {})}
					readOnly={false}
					models={models}
					onClose={close}
					onSaved={(saved) => {
						const { agent } = opened;
						const recruits = opened.preset?.recruits ?? [];
						setOpened({ agent, preset: { ...saved, agent, recruits } });
						reload();
					}}
					onDeleted={close}
					onTransferred={close}
				/>
			) : null}
		</section>
	);
}
