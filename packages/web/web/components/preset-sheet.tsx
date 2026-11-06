import { useEffect, useState } from "react";
import type {
	AgentProfileView,
	PresetsView,
	PresetView,
	SharedPresetView,
} from "../../src/api-types.ts";
import { api, messageOf } from "../lib/api.ts";
import { translate as t } from "../lib/messages.ts";
import { teamApi } from "../lib/team-api.ts";
import type { KnightSeed } from "../lib/team-sheet.ts";
import { useKnights } from "./knight-picker.tsx";
import { PresetSheet } from "./preset-editor.tsx";
import { Failure } from "./states.tsx";

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

/** What the card has open: one of the knight's presets or a new one, one shared with it, or the knight copied. */
type Opened =
	| { kind: "own"; preset?: PresetView }
	| { kind: "shared"; preset: SharedPresetView }
	| { kind: "knight"; seed: KnightSeed };

/** The knight's own fields as a preset's, its look included; its skills come with the catalog. */
const seedOf = (knight: AgentProfileView): KnightSeed => {
	const { v: _v, ...character } = knight.character;
	return {
		displayName: knight.displayName,
		prompt: knight.prompt,
		skills: [],
		character,
		...(knight.model ? { model: knight.model } : {}),
		...(knight.thinking ? { thinking: knight.thinking } : {}),
	};
};

/**
 * A knight's temp-knight presets on its sheet: one row each, a tap opening the preset's editor, and a
 * new one up to the most it may keep, blank or copied from the knight. Below them, read-only, the
 * presets other knights share with it. Shown only where the host makes temp knights.
 */
export function PresetCard(props: {
	knight: AgentProfileView;
	models: readonly string[];
}) {
	const agent = props.knight.name;
	const [view, setView] = useState<PresetsView>();
	const [error, setError] = useState<string>();
	const [opened, setOpened] = useState<Opened>();
	const knights = useKnights();
	const nameOf = (name: string) =>
		knights.find((one) => one.name === name)?.displayName ?? name;
	useEffect(() => {
		let current = true;
		// Without a session to read, as without temp knights, the card stays away.
		api
			.session()
			.then(
				(session) => (session.helpers ? teamApi.presets(agent) : undefined),
				() => undefined,
			)
			.then(
				(loaded) => current && loaded && setView(loaded),
				(failure) => current && setError(messageOf(failure)),
			);
		return () => {
			current = false;
		};
	}, [agent]);
	if (error) return <Failure message={error} />;
	if (!view) return null;
	const { presets, shared, max } = view;
	const keep = (saved: PresetView) =>
		setView({
			...view,
			presets: [...presets.filter((p) => p.name !== saved.name), saved].sort(
				(a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
			),
		});
	const row = (
		preset: PresetView,
		meta: string,
		open: Opened,
		key: Record<string, string>,
	) => (
		<li key={Object.values(key)[0]}>
			<button
				type="button"
				className="menu-item"
				{...key}
				aria-haspopup="dialog"
				onClick={() => setOpened(open)}
			>
				<span className="menu-text">
					<strong>
						{preset.name} · {preset.displayName}
					</strong>
					<span className="meta">{meta}</span>
				</span>
			</button>
		</li>
	);
	const owner = opened?.kind === "shared" ? opened.preset.agent : agent;
	return (
		<section className="card stack" data-presets="">
			<h3>
				{t("Temp knight presets ({count}/{max})", {
					count: presets.length,
					max,
				})}
			</h3>
			{presets.length + shared.length > 0 ? (
				<ul className="menu">
					{presets.map((preset) =>
						row(
							preset,
							`${t("Skills ({count})", { count: preset.skills.length })} · ${firstLine(preset.prompt)}`,
							{ kind: "own", preset },
							{ "data-preset": preset.name },
						),
					)}
					{shared.map((preset) =>
						row(
							preset,
							t("Shared by {name}", { name: nameOf(preset.agent) }),
							{ kind: "shared", preset },
							{ "data-shared-preset": `${preset.agent}/${preset.name}` },
						),
					)}
				</ul>
			) : null}
			<div className="actions">
				<button
					type="button"
					className="secondary"
					disabled={presets.length >= max}
					onClick={() =>
						setOpened({ kind: "knight", seed: seedOf(props.knight) })
					}
				>
					{t("Save as preset")}
				</button>
				<button
					type="button"
					className="secondary"
					disabled={presets.length >= max}
					onClick={() => setOpened({ kind: "own" })}
				>
					{t("New preset")}
				</button>
			</div>
			{opened ? (
				<PresetSheet
					agent={owner}
					agentName={owner === agent ? props.knight.displayName : nameOf(owner)}
					{...(opened.kind === "knight"
						? { seed: opened.seed }
						: opened.preset
							? { preset: opened.preset }
							: {})}
					readOnly={opened.kind === "shared"}
					models={props.models}
					onClose={() => setOpened(undefined)}
					onSaved={(saved) => {
						keep(saved);
						setOpened({ kind: "own", preset: saved });
					}}
					onDeleted={(name) => {
						setView({
							...view,
							presets: presets.filter((p) => p.name !== name),
						});
						setOpened(undefined);
					}}
				/>
			) : null}
		</section>
	);
}
