import { Fragment, lazy, Suspense, useEffect, useState } from "react";
import type {
	SessionView,
	SkillDetailView,
	SkillView,
} from "../../src/api-types.ts";
import { Confirm } from "../components/confirm.tsx";
import { Dialog } from "../components/dialog.tsx";
import { Icon } from "../components/icons.tsx";
import { MarkdownDocument } from "../components/markdown.tsx";
import { Badge, Empty, Failure, Loading } from "../components/states.tsx";
import { api, messageOf } from "../lib/api.ts";
import { editApi } from "../lib/edit-api.ts";
import { translate as t } from "../lib/messages.ts";
import { toast } from "../lib/toast.ts";
import { useFetched } from "../lib/use-fetched.ts";

// The editor is a full-screen text and its history; it loads when a skill is opened for editing.
const SkillEditor = lazy(() =>
	import("../components/skill-editor.tsx").then((m) => ({
		default: m.SkillEditor,
	})),
);

/** What is being edited: a skill by name, or a new one when there is no name. */
type Editing = { name: string | undefined } | undefined;

export function SkillsPage() {
	const [version, setVersion] = useState(0);
	const { data: skills, error } = useFetched(
		() => api.skills(),
		`skills:${version}`,
	);
	const [session, setSession] = useState<SessionView>();
	const [editing, setEditing] = useState<Editing>();
	const [deleting, setDeleting] = useState<SkillView>();
	useEffect(() => {
		// Without the owner app there is no session, and the skills stay as they were: read-only.
		api.session().then(setSession, () => undefined);
	}, []);
	const canEdit = session?.skillEdit === true;
	return (
		<section className="stack">
			<div className="card-head">
				<h2>{t("Skills")}</h2>
				{canEdit ? (
					<button
						type="button"
						className="secondary"
						onClick={() => setEditing({ name: undefined })}
					>
						<Icon name="plus" size={16} />
						{t("New skill")}
					</button>
				) : null}
			</div>
			<p className="hint">
				{canEdit
					? t(
							"Registered skills and their carriers. A skill a knight wrote can be edited here; the others are read-only.",
						)
					: t(
							"Registered skills and their carriers; ask a knight on Discord to edit their contents.",
						)}
			</p>
			{error ? <Failure message={error} /> : null}
			{!skills && !error ? <Loading /> : null}
			{skills?.length === 0 ? <Empty>{t("No skills.")}</Empty> : null}
			{skills?.map((skill) => (
				<SkillCard
					key={`${skill.name}:${version}`}
					skill={skill}
					onEdit={
						// Only a skill an agent wrote is changed here; the others change where they come from.
						canEdit && skill.source.kind === "written"
							? () => setEditing({ name: skill.name })
							: undefined
					}
					onDelete={
						canEdit && skill.source.kind === "written"
							? () => setDeleting(skill)
							: undefined
					}
				/>
			))}
			{editing ? (
				<Suspense fallback={null}>
					<SkillEditor
						key={editing.name ?? ""}
						name={editing.name}
						onSaved={() => setVersion((n) => n + 1)}
						onClose={() => setEditing(undefined)}
					/>
				</Suspense>
			) : null}
			<Confirm
				open={deleting !== undefined}
				title={t("Delete this skill?")}
				confirmLabel={t("Delete skill")}
				tone="danger"
				onClose={() => setDeleting(undefined)}
				onConfirm={async () => {
					if (!deleting) return;
					await editApi.deleteSkillDocument(deleting.name);
					setVersion((n) => n + 1);
					toast(t("Deleted {name}.", { name: deleting.name }));
				}}
			>
				{deleting ? <DeleteNotice skill={deleting} /> : null}
			</Confirm>
		</section>
	);
}

/** What deleting a skill takes with it: it is detached from every knight and group that carries it. */
function DeleteNotice({ skill }: { skill: SkillView }) {
	return (
		<>
			<p>
				{skill.carriers.length
					? t(
							"{name} will be deleted and taken from the knights that carry it: {carriers}.",
							{ name: skill.name, carriers: skill.carriers.join(", ") },
						)
					: t("{name} will be deleted. No knight carries it.", {
							name: skill.name,
						})}
			</p>
			{skill.groups.length ? (
				<p>
					{t("It also leaves the skill groups {groups}.", {
						groups: skill.groups.join(", "),
					})}
				</p>
			) : null}
			<p>{t("This cannot be undone.")}</p>
		</>
	);
}

/** Why a skill cannot be edited here, in the words of where it comes from. */
function readOnlyReason(source: SkillView["source"]): string | undefined {
	switch (source.kind) {
		case "builtin":
			return t("Built in with the release; it changes with the release.");
		case "package":
			return t(
				"From the package {package}; it changes when the package is upgraded.",
				{
					package: source.package,
				},
			);
		case "linked":
			return t("Linked from {repo}; change it in its repository.", {
				repo: `${source.repo}:${source.path}`,
			});
		default:
			return undefined;
	}
}

function SkillCard({
	skill,
	onEdit,
	onDelete,
}: {
	skill: SkillView;
	/** Present when the skill can be edited here: an agent-written one on a host that allows it. */
	onEdit?: (() => void) | undefined;
	/** Present when the skill can be deleted here, as it can be edited. */
	onDelete?: (() => void) | undefined;
}) {
	const [open, setOpen] = useState(false);
	const [detail, setDetail] = useState<SkillDetailView>();
	const [error, setError] = useState<string>();
	const source =
		skill.source.kind === "builtin"
			? t("Built-in")
			: skill.source.kind === "written"
				? t("Knight-written")
				: skill.source.kind === "package"
					? skill.source.package
					: `${skill.source.repo}:${skill.source.path}`;
	return (
		<article className="card">
			<div className="card-head">
				<strong>{skill.name}</strong>
				<Badge>{source}</Badge>
				{skill.missing ? (
					<Badge tone="warn">{t("File missing")}</Badge>
				) : (
					<>
						{onEdit ? (
							<button type="button" className="secondary" onClick={onEdit}>
								{t("Edit")}
							</button>
						) : null}
						<button
							type="button"
							className="secondary"
							onClick={() => {
								setOpen(true);
								if (!detail) {
									setError(undefined);
									api
										.skill(skill.name)
										.then(setDetail)
										.catch((f) => setError(messageOf(f)));
								}
							}}
						>
							SKILL.md
						</button>
					</>
				)}
				{onDelete ? (
					<button type="button" className="secondary" onClick={onDelete}>
						{t("Delete")}
					</button>
				) : null}
			</div>
			<p>{skill.missing ?? skill.description}</p>
			{skill.source.kind !== "written" ? (
				<p className="hint skill-lock">
					<Icon name="lock" size={14} />
					<span>{readOnlyReason(skill.source)}</span>
				</p>
			) : null}
			<p className="hint">
				{t("Carriers")}:{" "}
				{skill.source.kind === "builtin"
					? t("All knights")
					: skill.carriers.join(", ") || t("None")}
			</p>
			{skill.groups.length ? (
				<p className="hint">
					{t("Groups")}: {skill.groups.join(", ")}
				</p>
			) : null}
			<Dialog
				open={open}
				title={skill.name}
				size="wide"
				onClose={() => setOpen(false)}
			>
				{error ? (
					<Failure message={error} />
				) : !detail ? (
					<Loading />
				) : (
					<SkillDocument title={skill.name} detail={detail} />
				)}
			</Dialog>
		</article>
	);
}

/** A skill's frontmatter as a short list of keys and values, then its Markdown at a reading width. */
export function SkillDocument({
	title,
	detail,
}: {
	/** The dialog's title; a `name` entry that repeats it says nothing new. */
	title: string;
	detail: SkillDetailView;
}) {
	const entries = detail.metadata.filter(
		(entry) => !(entry.key === "name" && entry.value === title),
	);
	return (
		<div className="skill-document">
			{entries.length ? (
				<dl className="skill-meta">
					{entries.map((entry) => (
						<Fragment key={entry.key}>
							<dt>{entry.key}</dt>
							<dd>{entry.value}</dd>
						</Fragment>
					))}
				</dl>
			) : null}
			<MarkdownDocument source={detail.body} />
		</div>
	);
}
