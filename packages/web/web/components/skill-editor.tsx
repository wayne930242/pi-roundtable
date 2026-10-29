import { lazy, Suspense, useEffect, useId, useState } from "react";
import type { SkillDocView } from "../../src/api-types.ts";
import { ApiFailure, messageOf } from "../lib/api.ts";
import { editApi } from "../lib/edit-api.ts";
import { translate as t } from "../lib/messages.ts";
import { toast } from "../lib/toast.ts";
import { TextDiff } from "./diff-block.tsx";
import { Icon } from "./icons.tsx";
import { Sheet } from "./sheet.tsx";
import { Failure, Loading } from "./states.tsx";

// The history is read now and then; it loads when it is asked for.
const HistorySheet = lazy(() =>
	import("./prompt-history.tsx").then((m) => ({ default: m.HistorySheet })),
);

/** What a new skill starts from: the two frontmatter fields the skill tools keep, and a body to fill. */
const TEMPLATE = `---
name: my-skill
description: "Use when "
---

# My skill

`;

/**
 * A skill's SKILL.md, whole, in a full-screen editor: the frontmatter (name and description) and the
 * body. A change is read over as a diff before it is saved, and the server checks it as it checks
 * what an agent writes. Without a `name` it makes a new skill. A save names the version it was
 * edited from; when another save came first, the diff is read again against that one.
 */
export function SkillEditor(props: {
	name?: string | undefined;
	onSaved(): void;
	onClose(): void;
}) {
	const { name } = props;
	const [doc, setDoc] = useState<SkillDocView>();
	const [draft, setDraft] = useState(name ? "" : TEMPLATE);
	const [error, setError] = useState<string>();
	const [reviewing, setReviewing] = useState(false);
	const [saving, setSaving] = useState(false);
	const [conflicted, setConflicted] = useState(false);
	const [history, setHistory] = useState(false);
	const field = useId();
	useEffect(() => {
		if (!name) return;
		let current = true;
		editApi.skillDocument(name).then(
			(loaded) => {
				if (!current) return;
				setDoc(loaded);
				setDraft(loaded.text);
			},
			(failure) => current && setError(messageOf(failure)),
		);
		return () => {
			current = false;
		};
	}, [name]);

	const before = doc?.text ?? "";
	const dirty = draft !== before;
	const loading = name !== undefined && !doc && !error;

	const save = async () => {
		setSaving(true);
		try {
			if (doc) {
				const saved = await editApi.saveSkillDocument(doc.name, {
					text: draft,
					baseHash: doc.hash,
				});
				setDoc(saved);
				setDraft(saved.text);
				setReviewing(false);
				setConflicted(false);
				toast(t("Saved."));
				props.onSaved();
			} else {
				await editApi.createSkillDocument({ text: draft });
				toast(t("Skill created."));
				props.onSaved();
				props.onClose();
			}
		} catch (failure) {
			if (failure instanceof ApiFailure && failure.status === 409) {
				// Another save came first: the diff is read again against what is there now, and the draft is kept.
				const { current } = failure.body as { current: SkillDocView };
				setDoc(current);
				setConflicted(true);
			} else toast(messageOf(failure), "danger");
		} finally {
			setSaving(false);
		}
	};

	return (
		<Sheet
			open
			title={name ?? t("New skill")}
			size="full"
			onClose={props.onClose}
		>
			{error ? <Failure message={error} /> : null}
			{loading ? <Loading /> : null}
			{doc && !doc.writable ? (
				<Failure message={t("This skill cannot be edited here.")} />
			) : null}
			{!loading && !error && (!doc || doc.writable) ? (
				<div className="stack">
					{reviewing ? (
						<section className="stack review" aria-label={t("Review changes")}>
							<h3>{t("Review changes")}</h3>
							{conflicted ? (
								<Failure
									message={t(
										"This skill changed while you were editing it. The changes below are against the version there now; save again to replace it, or go back to edit.",
									)}
								/>
							) : null}
							<TextDiff label="SKILL.md" before={before} after={draft} />
							<div className="actions">
								<button
									type="button"
									className="secondary"
									disabled={saving}
									onClick={() => setReviewing(false)}
								>
									{t("Back to editing")}
								</button>
								<button type="button" disabled={saving} onClick={save}>
									{saving ? t("Saving…") : doc ? t("Save") : t("Create skill")}
								</button>
							</div>
						</section>
					) : (
						<>
							<div className="field">
								<div className="field-head">
									<label htmlFor={field}>SKILL.md</label>
									{doc ? (
										<span className="field-tools">
											<button
												type="button"
												className="secondary compact"
												aria-haspopup="dialog"
												onClick={() => setHistory(true)}
											>
												<Icon name="reset" size={16} />
												{t("History")}
											</button>
										</span>
									) : null}
								</div>
								<textarea
									id={field}
									className="prompt-full"
									spellCheck={false}
									value={draft}
									onChange={(event) => setDraft(event.target.value)}
								/>
								<p className="meta">
									{t(
										"Frontmatter holds the name, which cannot change, and a description that starts with “Use when”. The rest is the skill.",
									)}
								</p>
							</div>
							<div className="actions">
								<button
									type="button"
									disabled={!dirty || !draft.trim()}
									onClick={() => setReviewing(true)}
								>
									{t("Review changes")}
								</button>
							</div>
						</>
					)}
					{history && doc ? (
						<Suspense fallback={null}>
							<HistorySheet
								open={history}
								title={t("History of {name}", { name: doc.name })}
								load={async () => {
									const { versions } = await editApi.skillHistory(doc.name);
									// A version's change is read against the one before it; the first is read against nothing.
									return versions.map((version, index) => ({
										id: version.id,
										text: version.text,
										previous: versions[index + 1]?.text ?? "",
										by: version.by,
										at: version.at,
									}));
								}}
								onUse={(text) => {
									setDraft(text);
									setReviewing(false);
									setHistory(false);
								}}
								onClose={() => setHistory(false)}
							/>
						</Suspense>
					) : null}
				</div>
			) : null}
		</Sheet>
	);
}
