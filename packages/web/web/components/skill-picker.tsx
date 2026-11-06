import { useEffect, useId, useState } from "react";
import type { SkillChoiceView, SkillGroupView } from "../../src/api-types.ts";
import { installAgentSheetStyle } from "../lib/agent-sheet-style.ts";
import { editApi } from "../lib/edit-api.ts";
import { translate as t } from "../lib/messages.ts";
import { Icon } from "./icons.tsx";
import { ApplyGroup, type GroupApplied } from "./skill-apply.tsx";

export type { GroupApplied } from "./skill-apply.tsx";

installAgentSheetStyle();

/** How many rows the list shows before "Show all", when nothing is searched. */
export const SKILL_ROWS = 8;

const describe = (skill: SkillChoiceView): string =>
	skill.missing
		? t("Its file cannot be read.")
		: skill.builtin
			? t("Built in: every knight carries it.")
			: (skill.description ?? "");

/**
 * The host's skills for a knight: the carried ones on top as chips to remove, the built-in ones as one
 * chip that stays, and below a list of the others to add, searched by name and description and
 * filtered by a skill group, whose switch applies the group at once. It holds no skills of its own:
 * the agent sheet saves each change as it is made, a preset's editor keeps them in its draft.
 */
export function SkillPicker(props: {
	skills: readonly SkillChoiceView[];
	/** Who carries them, as the group confirmation names it. */
	who: string;
	/** The skill being saved, whose control shows busy. */
	busy?: string | undefined;
	onFlip(skill: string, next: boolean): void;
	onApplyGroup(group: SkillGroupView, on: boolean): Promise<GroupApplied>;
}) {
	const [groups, setGroups] = useState<SkillGroupView[]>();
	const [query, setQuery] = useState("");
	const [group, setGroup] = useState<string>();
	const [carriedToo, setCarriedToo] = useState(false);
	const [all, setAll] = useState(false);
	const [open, setOpen] = useState<string>();
	const searchId = useId();
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
	const builtins = props.skills.filter((skill) => skill.builtin);
	const carried = props.skills.filter(
		(skill) => skill.carried && !skill.builtin,
	);
	const chosen = groups?.find((one) => one.name === group);
	const words = query.trim().toLowerCase();
	const matching = props.skills.filter(
		(skill) =>
			!skill.builtin &&
			(carriedToo || !skill.carried) &&
			(!chosen || chosen.skills.includes(skill.name)) &&
			(!words ||
				`${skill.name} ${skill.description ?? ""}`
					.toLowerCase()
					.includes(words)),
	);
	const folded = !words && !all && matching.length > SKILL_ROWS;
	const shown = folded ? matching.slice(0, SKILL_ROWS) : matching;
	const busy = (skill: string) => props.busy === skill;
	return (
		<div className="stack skill-picker">
			<div className="skill-chips">
				<span className="meta">
					{t("{count} carried", {
						count: carried.length + builtins.length,
					})}
				</span>
				{builtins.length ? (
					<span
						className="skill-chip"
						data-builtin=""
						title={builtins.map((skill) => skill.name).join(", ")}
					>
						{t("{count} built in", { count: builtins.length })}
					</span>
				) : null}
				{carried.map((skill) => (
					<button
						key={skill.name}
						type="button"
						className="skill-chip"
						title={describe(skill)}
						{...(skill.missing ? { "data-missing": "" } : {})}
						aria-label={t("Remove {name}", { name: skill.name })}
						aria-busy={busy(skill.name) || undefined}
						disabled={busy(skill.name)}
						onClick={() => props.onFlip(skill.name, false)}
					>
						{skill.name}
						<Icon name="close" size={14} />
					</button>
				))}
			</div>
			<label className="skill-search" htmlFor={searchId}>
				<Icon name="search" size={16} />
				<input
					id={searchId}
					type="search"
					aria-label={t("Search {name}", { name: t("Skills") })}
					placeholder={t("Search {name}", { name: t("Skills") })}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
			</label>
			<fieldset
				className="option-chips skill-filters"
				aria-label={t("Skill groups")}
			>
				{(groups ?? []).map((one) => (
					<button
						key={one.name}
						type="button"
						className="option-chip"
						aria-pressed={one.name === group}
						onClick={() => setGroup(one.name === group ? undefined : one.name)}
					>
						{one.name}
					</button>
				))}
				<button
					type="button"
					className="option-chip"
					aria-pressed={carriedToo}
					onClick={() => setCarriedToo(!carriedToo)}
				>
					{t("Show carried")}
				</button>
			</fieldset>
			{chosen ? (
				<ApplyGroup
					key={chosen.name}
					group={chosen}
					skills={props.skills}
					who={props.who}
					onApplyGroup={props.onApplyGroup}
				/>
			) : null}
			{shown.length === 0 ? (
				<p className="meta">{t("Nothing matches.")}</p>
			) : (
				<ul className="skill-rows">
					{shown.map((skill) => {
						const text = describe(skill);
						const expanded = open === skill.name;
						return (
							<li
								key={skill.name}
								{...(skill.missing ? { "data-missing": "" } : {})}
							>
								<button
									type="button"
									className="skill-row-text"
									aria-expanded={expanded}
									title={text}
									onClick={() => setOpen(expanded ? undefined : skill.name)}
								>
									<strong>{skill.name}</strong>
									<span className="meta" data-full={expanded || undefined}>
										{text}
									</span>
								</button>
								<button
									type="button"
									className="secondary icon-button"
									aria-label={skill.name}
									aria-pressed={skill.carried}
									aria-busy={busy(skill.name) || undefined}
									disabled={busy(skill.name)}
									onClick={() => props.onFlip(skill.name, !skill.carried)}
								>
									<Icon name={skill.carried ? "close" : "plus"} size={16} />
								</button>
							</li>
						);
					})}
				</ul>
			)}
			{folded ? (
				<button
					type="button"
					className="secondary compact"
					onClick={() => setAll(true)}
				>
					{t("Show all ({count})", { count: matching.length })}
				</button>
			) : null}
		</div>
	);
}
