import { useId, useState } from "react";
import type { SkillChoiceView, SkillGroupView } from "../../src/api-types.ts";
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
 * One skill group's switch, on one line: on, after a confirmation, switches on the group's skills the
 * knight lacks; off switches off the group's skills it carries, built-in ones excepted. It shows on
 * when the knight carries all of it. The knight carries the skills, not the group.
 */
export function ApplyGroup(props: {
	group: SkillGroupView;
	skills: readonly SkillChoiceView[];
	who: string;
	onApplyGroup(group: SkillGroupView, on: boolean): Promise<GroupApplied>;
}) {
	const { group } = props;
	const [pending, setPending] = useState<boolean>();
	const id = useId();
	const carried = new Set(
		props.skills.filter((skill) => skill.carried).map((skill) => skill.name),
	);
	const locked = new Set(
		props.skills.filter((skill) => skill.builtin).map((skill) => skill.name),
	);
	const lacking = group.skills.filter((skill) => !carried.has(skill));
	const dropping = group.skills.filter(
		(skill) => carried.has(skill) && !locked.has(skill),
	);
	const on = lacking.length === 0;
	return (
		<div className="skill-apply">
			<label className="menu-item menu-toggle" htmlFor={id}>
				<span className="menu-text">
					<strong>{group.name}</strong>
					<span className="meta">
						{on
							? t("Carries all of it.")
							: t("Lacks {count}: {skills}", {
									count: lacking.length,
									skills: lacking.join(", "),
								})}
					</span>
				</span>
				<Switch
					id={id}
					checked={on}
					label={t("Skill group {name}", { name: group.name })}
					disabled={on && dropping.length === 0}
					onChange={(next) => setPending(next)}
				/>
			</label>
			<Confirm
				open={pending !== undefined}
				title={
					pending
						? t("Switch this skill group on?")
						: t("Switch this skill group off?")
				}
				confirmLabel={pending ? t("Switch on") : t("Switch off")}
				tone={pending ? "primary" : "danger"}
				onClose={() => setPending(undefined)}
				onConfirm={async () => {
					if (pending === undefined) return;
					const { added, removed } = await props.onApplyGroup(group, pending);
					toast(
						added.length
							? t("Switched on: {skills}", { skills: added.join(", ") })
							: removed.length
								? t("Switched off: {skills}", { skills: removed.join(", ") })
								: t("Nothing changed for {name}.", { name: group.name }),
					);
				}}
			>
				<p>
					{pending === undefined
						? null
						: pending
							? t("{agent} will also carry: {skills}.", {
									agent: props.who,
									skills: lacking.join(", "),
								})
							: t("{agent} will no longer carry: {skills}.", {
									agent: props.who,
									skills: dropping.join(", "),
								})}
				</p>
			</Confirm>
		</div>
	);
}
