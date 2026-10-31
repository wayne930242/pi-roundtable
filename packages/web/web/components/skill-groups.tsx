import { type SyntheticEvent, useState } from "react";
import type { SkillGroupView, SkillView } from "../../src/api-types.ts";
import { messageOf } from "../lib/api.ts";
import { editApi } from "../lib/edit-api.ts";
import { translate as t } from "../lib/messages.ts";
import { toast } from "../lib/toast.ts";
import { useReloadable } from "../lib/use-reloadable.ts";
import { Confirm } from "./confirm.tsx";
import { Dialog } from "./dialog.tsx";
import { Icon } from "./icons.tsx";
import { Empty, Failure, Loading } from "./states.tsx";

/** What is being edited: a group, or a new one when there is none. */
type Editing = { group: SkillGroupView | undefined } | undefined;

/**
 * The skill groups: named lists of skills to apply to a knight once. A knight carries skills, not
 * groups, so changing or deleting a group changes no knight. `onChanged` reads the catalog again,
 * whose cards name the groups each skill is in.
 */
export function SkillGroups(props: {
	catalog: readonly SkillView[];
	onChanged(): void;
}) {
	const { data, error, reload } = useReloadable(() => editApi.skillGroups());
	const [editing, setEditing] = useState<Editing>();
	const [deleting, setDeleting] = useState<SkillGroupView>();
	const changed = () => {
		reload();
		props.onChanged();
	};
	return (
		<section className="stack" aria-label={t("Skill groups")}>
			<div className="card-head">
				<h2>{t("Skill groups")}</h2>
				<button
					type="button"
					className="secondary"
					onClick={() => setEditing({ group: undefined })}
				>
					<Icon name="plus" size={16} />
					{t("New group")}
				</button>
			</div>
			<p className="hint">
				{t(
					"A group lists skills to switch on for a knight in one step, from the knight's sheet. Knights carry the skills, not the group.",
				)}
			</p>
			{error ? <Failure message={error} /> : null}
			{!data && !error ? <Loading /> : null}
			{data?.groups.length === 0 ? (
				<Empty>{t("No skill groups.")}</Empty>
			) : null}
			{data?.groups.map((group) => (
				<article className="card skill-group" key={group.name}>
					<div className="card-head">
						<strong>{group.name}</strong>
						<button
							type="button"
							className="secondary"
							onClick={() => setEditing({ group })}
						>
							{t("Edit")}
						</button>
						<button
							type="button"
							className="secondary"
							onClick={() => setDeleting(group)}
						>
							{t("Delete")}
						</button>
					</div>
					<p>{group.description}</p>
					<p className="hint">
						{t("Skills")}: {group.skills.join(", ") || t("None")}
					</p>
				</article>
			))}
			<Dialog
				open={editing !== undefined}
				title={
					editing?.group
						? t("Edit {name}", { name: editing.group.name })
						: t("New skill group")
				}
				onClose={() => setEditing(undefined)}
			>
				{editing ? (
					<GroupForm
						key={editing.group?.name ?? ""}
						group={editing.group}
						catalog={props.catalog}
						onCancel={() => setEditing(undefined)}
						onDone={() => {
							setEditing(undefined);
							changed();
						}}
					/>
				) : null}
			</Dialog>
			<Confirm
				open={deleting !== undefined}
				title={t("Delete this skill group?")}
				confirmLabel={t("Delete group")}
				tone="danger"
				onClose={() => setDeleting(undefined)}
				onConfirm={async () => {
					if (!deleting) return;
					await editApi.deleteSkillGroup(deleting.name);
					toast(t("Deleted {name}.", { name: deleting.name }));
					changed();
				}}
			>
				<p>
					{t(
						"{name} will be deleted. Its skills stay, and so does every knight that carries them.",
						{ name: deleting?.name ?? "" },
					)}
				</p>
			</Confirm>
		</section>
	);
}

/** A group's name, description and skills, picked from the catalog. */
function GroupForm(props: {
	group: SkillGroupView | undefined;
	catalog: readonly SkillView[];
	onDone(): void;
	onCancel(): void;
}) {
	const [name, setName] = useState(props.group?.name ?? "");
	const [description, setDescription] = useState(
		props.group?.description ?? "",
	);
	const [skills, setSkills] = useState<string[]>(props.group?.skills ?? []);
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const submit = async (event: SyntheticEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(undefined);
		try {
			const from = props.group?.name;
			await editApi.saveSkillGroup(name.trim(), {
				description,
				// In the catalog's order, so the group reads as the page does.
				skills: [
					...props.catalog
						.map((skill) => skill.name)
						.filter((skill) => skills.includes(skill)),
					...skills.filter(
						(skill) => !props.catalog.some((one) => one.name === skill),
					),
				],
				...(from ? { from } : {}),
			});
			toast(t("Saved {name}.", { name: name.trim() }));
			props.onDone();
		} catch (failure) {
			setError(messageOf(failure));
		} finally {
			setBusy(false);
		}
	};
	return (
		<form className="stack" onSubmit={submit} autoComplete="off">
			<label>
				{t("Name")}
				<input
					value={name}
					maxLength={64}
					placeholder="coding"
					required
					onChange={(e) => setName(e.target.value)}
				/>
				<span className="meta">
					{t("Lowercase letters, digits and single hyphens, up to 64.")}
				</span>
			</label>
			<label>
				{t("Description")}
				<textarea
					value={description}
					maxLength={1000}
					rows={2}
					required
					onChange={(e) => setDescription(e.target.value)}
				/>
			</label>
			<fieldset className="field">
				<legend>{t("Skills")}</legend>
				<ul className="menu">
					{props.catalog.map((skill) => {
						const on = skills.includes(skill.name);
						return (
							<li key={skill.name}>
								<label className="menu-item menu-toggle">
									<input
										type="checkbox"
										checked={on}
										onChange={() =>
											setSkills(
												on
													? skills.filter((one) => one !== skill.name)
													: [...skills, skill.name],
											)
										}
									/>
									<span className="menu-text">
										<strong>{skill.name}</strong>
										{skill.description ? (
											<span className="meta">{skill.description}</span>
										) : null}
									</span>
								</label>
							</li>
						);
					})}
				</ul>
			</fieldset>
			{error ? <Failure message={error} /> : null}
			<div className="actions">
				<button
					type="button"
					className="secondary"
					disabled={busy}
					onClick={props.onCancel}
				>
					{t("Cancel")}
				</button>
				<button type="submit" disabled={busy}>
					{t("Save group")}
				</button>
			</div>
		</form>
	);
}
