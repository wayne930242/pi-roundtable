import { useEffect, useRef, useState } from "react";
import type { AgentSkillsView } from "../../src/api-types.ts";
import { currentAgentSheet } from "../lib/agent-sheet.ts";
import { ApiFailure, messageOf } from "../lib/api.ts";
import { editApi } from "../lib/edit-api.ts";
import { translate as t } from "../lib/messages.ts";
import { teamApi } from "../lib/team-api.ts";
import { toast } from "../lib/toast.ts";
import { SkillPicker } from "./skill-picker.tsx";
import { Failure } from "./states.tsx";

/**
 * The skills the agent carries, from the host's catalog: a switch each, applied as it is flipped.
 * The built-in ones are carried by every agent and stay on. A host without skills shows nothing.
 */
export function Skills({
	name,
	opened,
	onAbsent,
}: {
	name: string;
	opened: number;
	/** The host has no skills: the sheet leaves out their tab. */
	onAbsent(): void;
}) {
	const [view, setView] = useState<AgentSkillsView>();
	const [busy, setBusy] = useState<string>();
	const [error, setError] = useState<string>();
	const section = useRef<HTMLElement>(null);
	const loaded = view !== undefined;
	// "Skills" in a menu lands here once the list has come.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `opened` is a new ask for the same agent
	useEffect(() => {
		if (!loaded || currentAgentSheet()?.tab !== "skills") return;
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
				if (!current) return;
				if (failure instanceof ApiFailure && failure.status === 404) onAbsent();
				else setError(messageOf(failure));
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
