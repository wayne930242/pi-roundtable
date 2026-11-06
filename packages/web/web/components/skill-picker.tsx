import { useEffect, useId, useState } from "react";
import type { SkillChoiceView, SkillGroupView } from "../../src/api-types.ts";
import { editApi } from "../lib/edit-api.ts";
import { translate as t } from "../lib/messages.ts";
import { toast } from "../lib/toast.ts";
import { Confirm } from "./confirm.tsx";
import { Switch } from "./switch.tsx";

/** What applying a skill group changed. */
export interface GroupApplied {
	added: string[];
	removed: string[];
}

/**
 * The host's skills as a switch each, `carried` the ones on, and the skill groups to apply at once.
 * The built-in ones are carried by every knight and stay on. It holds no skills of its own: the
 * agent sheet saves each switch as it is flipped, a preset's editor keeps them in its draft.
 */
export function SkillPicker(props: {
	skills: readonly SkillChoiceView[];
	/** Who carries them, as the group confirmation names it. */
	who: string;
	/** The skill being saved, whose switch shows busy. */
	busy?: string | undefined;
	onFlip(skill: string, next: boolean): void;
	onApplyGroup(group: SkillGroupView, on: boolean): Promise<GroupApplied>;
}) {
	const prefix = useId();
	return (
		<>
			<ul className="menu">
				{props.skills.map((skill, index) => {
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
									busy={props.busy === skill.name}
									disabled={skill.builtin}
									onChange={(next) => props.onFlip(skill.name, next)}
								/>
							</label>
						</li>
					);
				})}
			</ul>
			<ApplyGroup {...props} />
		</>
	);
}

/**
 * A switch per skill group: on, after a confirmation, switches on the group's skills the knight lacks;
 * off switches off the group's skills it carries, built-in ones excepted. A group shows on when the
 * knight carries all of it. The knight carries the skills, not the group. A host without groups, or an
 * app without them, shows nothing.
 */
function ApplyGroup(props: {
	skills: readonly SkillChoiceView[];
	who: string;
	onApplyGroup(group: SkillGroupView, on: boolean): Promise<GroupApplied>;
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
		props.skills.filter((skill) => skill.carried).map((skill) => skill.name),
	);
	const locked = new Set(
		props.skills.filter((skill) => skill.builtin).map((skill) => skill.name),
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
					const { added, removed } = await props.onApplyGroup(
						pending.group,
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
				}}
			>
				<p>
					{pending
						? pending.on
							? t("{agent} will also carry: {skills}.", {
									agent: props.who,
									skills: lacking(pending.group).join(", "),
								})
							: t("{agent} will no longer carry: {skills}.", {
									agent: props.who,
									skills: dropping(pending.group).join(", "),
								})
						: null}
				</p>
			</Confirm>
		</div>
	);
}
