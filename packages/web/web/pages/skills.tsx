import { Fragment, useState } from "react";
import type { SkillDetailView, SkillView } from "../../src/api-types.ts";
import { Dialog } from "../components/dialog.tsx";
import { MarkdownDocument } from "../components/markdown.tsx";
import { Badge, Empty, Failure, Loading } from "../components/states.tsx";
import { api, messageOf } from "../lib/api.ts";
import { translate as t } from "../lib/messages.ts";
import { useFetched } from "../lib/use-fetched.ts";

export function SkillsPage() {
	const { data: skills, error } = useFetched(() => api.skills(), "skills");
	return (
		<section className="stack">
			<h2>{t("Skills")}</h2>
			<p className="hint">
				{t(
					"Registered skills and their carriers; ask an agent on Discord to edit their contents.",
				)}
			</p>
			{error ? <Failure message={error} /> : null}
			{!skills && !error ? <Loading /> : null}
			{skills?.length === 0 ? <Empty>{t("No skills.")}</Empty> : null}
			{skills?.map((skill) => (
				<SkillCard key={skill.name} skill={skill} />
			))}
		</section>
	);
}

function SkillCard({ skill }: { skill: SkillView }) {
	const [open, setOpen] = useState(false);
	const [detail, setDetail] = useState<SkillDetailView>();
	const [error, setError] = useState<string>();
	const source =
		skill.source.kind === "builtin"
			? t("Built-in")
			: skill.source.kind === "written"
				? t("Assistant-written")
				: `${skill.source.repo}:${skill.source.path}`;
	return (
		<article className="card">
			<div className="card-head">
				<strong>{skill.name}</strong>
				<Badge>{source}</Badge>
				{skill.missing ? (
					<Badge tone="warn">{t("File missing")}</Badge>
				) : (
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
				)}
			</div>
			<p>{skill.missing ?? skill.description}</p>
			<p className="hint">
				{t("Carriers")}:{" "}
				{skill.source.kind === "builtin"
					? t("All agents")
					: skill.carriers.join(", ") || t("None")}
			</p>
			{skill.groups.length ? (
				<p className="hint">
					{t("Groups")}: {skill.groups.join(", ")}
				</p>
			) : null}
			<Dialog open={open} title={skill.name} onClose={() => setOpen(false)}>
				{error ? (
					<Failure message={error} />
				) : !detail ? (
					<Loading />
				) : (
					<div className="skill-document">
						<dl className="facts">
							{detail.metadata.map((entry) => (
								<Fragment key={entry.key}>
									<dt>{entry.key}</dt>
									<dd className="text">{entry.value}</dd>
								</Fragment>
							))}
						</dl>
						<MarkdownDocument source={detail.body} />
					</div>
				)}
			</Dialog>
		</article>
	);
}
