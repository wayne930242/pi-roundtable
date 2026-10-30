import { lazy, Suspense, useCallback, useEffect, useId, useState } from "react";
import type { PromptSummary, PromptView } from "../../src/api-types.ts";
import { TextDiff } from "../components/diff-block.tsx";
import { Icon } from "../components/icons.tsx";
import { Sheet } from "../components/sheet.tsx";
import { Badge, Empty, Failure, Loading } from "../components/states.tsx";
import { ApiFailure, messageOf } from "../lib/api.ts";
import { useConfig } from "../lib/config.ts";
import { editApi } from "../lib/edit-api.ts";
import { when } from "../lib/format.ts";
import { translate as t } from "../lib/messages.ts";
import { promptText } from "../lib/prompt-text.ts";
import { toast } from "../lib/toast.ts";

// The history is read now and then; it loads when it is asked for.
const HistorySheet = lazy(() =>
	import("../components/prompt-history.tsx").then((m) => ({
		default: m.HistorySheet,
	})),
);
const Confirm = lazy(() =>
	import("../components/confirm.tsx").then((m) => ({ default: m.Confirm })),
);

/** The main prompts: the texts every agent starts with, which the owner edits here instead of in a file. */
export function PromptsPage() {
	const { timeZone } = useConfig();
	const [documents, setDocuments] = useState<PromptSummary[]>();
	const [error, setError] = useState<string>();
	const [editing, setEditing] = useState<string>();
	const load = useCallback(() => {
		editApi.prompts().then(
			(view) => setDocuments(view.documents),
			(failure) => setError(messageOf(failure)),
		);
	}, []);
	useEffect(load, [load]);
	return (
		<div className="page">
			<header className="page-head">
				<h1>{t("Main prompts")}</h1>
			</header>
			<p className="hint">
				{t(
					"The texts the main knight and the other knights start from. A text you save here replaces the one from the file from the next turn on, until you go back to the file's.",
				)}
			</p>
			{error ? <Failure message={error} /> : null}
			{!documents && !error ? <Loading /> : null}
			{documents?.length === 0 ? (
				<Empty>{t("No prompts to edit.")}</Empty>
			) : null}
			{documents?.map((document) => (
				<article key={document.id} className="card stack">
					<div className="card-head">
						<strong>{promptText(document.label)}</strong>
						{document.differs ? (
							<Badge tone="warn">{t("Differs from the file version")}</Badge>
						) : null}
						{document.broken ? (
							<Badge tone="warn">{t("File version cannot be read")}</Badge>
						) : null}
					</div>
					{document.description ? (
						<p>{promptText(document.description)}</p>
					) : null}
					{document.override ? (
						<p className="hint">
							{t("Set by {name}, {time}", {
								name: document.override.by,
								time: when(document.override.at, timeZone),
							})}
						</p>
					) : null}
					<div className="actions">
						<button type="button" onClick={() => setEditing(document.id)}>
							{t("Edit")}
						</button>
					</div>
				</article>
			))}
			{editing ? (
				<PromptEditor
					id={editing}
					onClose={() => {
						setEditing(undefined);
						load();
					}}
				/>
			) : null}
		</div>
	);
}

/** One document in a full-screen editor: read over as a diff before it is saved, with its history and the way back to the file. */
function PromptEditor({ id, onClose }: { id: string; onClose(): void }) {
	const [view, setView] = useState<PromptView>();
	const [draft, setDraft] = useState("");
	const [error, setError] = useState<string>();
	const [reviewing, setReviewing] = useState(false);
	const [saving, setSaving] = useState(false);
	const [history, setHistory] = useState(false);
	const [reverting, setReverting] = useState(false);
	const field = useId();
	useEffect(() => {
		let current = true;
		editApi.prompt(id).then(
			(loaded) => {
				if (!current) return;
				setView(loaded);
				setDraft(loaded.text);
			},
			(failure) => current && setError(messageOf(failure)),
		);
		return () => {
			current = false;
		};
	}, [id]);

	const save = async () => {
		if (!view) return;
		setSaving(true);
		try {
			const saved = await editApi.savePrompt(id, {
				text: draft,
				base: view.text,
			});
			setView(saved);
			setDraft(saved.text);
			setReviewing(false);
			toast(t("Saved."));
		} catch (failure) {
			if (failure instanceof ApiFailure && failure.status === 409) {
				// Someone saved first: the diff is read again against what is there now, and the draft is kept.
				const { current } = failure.body as { current: PromptView };
				setView(current);
				toast(failure.message, "danger");
			} else toast(messageOf(failure), "danger");
		} finally {
			setSaving(false);
		}
	};

	const dirty = view !== undefined && draft !== view.text;
	return (
		<Sheet
			open
			title={view ? promptText(view.label) : t("Main prompts")}
			size="full"
			onClose={onClose}
		>
			{error ? <Failure message={error} /> : null}
			{!view && !error ? <Loading /> : null}
			{view?.broken ? (
				<Failure
					message={t(
						"The file version of this prompt cannot be read, so it cannot be changed here until it can: {reason}",
						{ reason: view.broken },
					)}
				/>
			) : null}
			{view && !view.broken ? (
				<div className="stack">
					{view.differs ? (
						<p className="hint">
							<Badge tone="warn">{t("Differs from the file version")}</Badge>
						</p>
					) : null}
					{reviewing ? (
						<section className="stack review" aria-label={t("Review changes")}>
							<h3>{t("Review changes")}</h3>
							<TextDiff label={t("Prompt")} before={view.text} after={draft} />
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
									{saving ? t("Saving…") : t("Save")}
								</button>
							</div>
						</section>
					) : (
						<>
							<div className="field">
								<div className="field-head">
									<label htmlFor={field}>{t("Prompt")}</label>
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
								</div>
								<textarea
									id={field}
									className="prompt-full"
									value={draft}
									maxLength={view.maxChars}
									onChange={(event) => setDraft(event.target.value)}
								/>
							</div>
							<div className="actions">
								{view.override ? (
									<button
										type="button"
										className="secondary"
										onClick={() => setReverting(true)}
									>
										{t("Revert to the file version")}
									</button>
								) : null}
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
					{history ? (
						<Suspense fallback={null}>
							<HistorySheet
								open={history}
								title={t("History of {name}", { name: promptText(view.label) })}
								load={async () =>
									(await editApi.promptHistory(id)).versions.map((v) => ({
										id: v.id,
										text: v.text,
										previous: v.previous,
										by: v.by,
										at: v.at,
										revert: v.action === "revert",
									}))
								}
								onUse={(text) => {
									setDraft(text);
									setReviewing(false);
									setHistory(false);
								}}
								onClose={() => setHistory(false)}
							/>
						</Suspense>
					) : null}
					{reverting ? (
						<Suspense fallback={null}>
							<Confirm
								open={reverting}
								title={t("Revert {name} to the file version?", {
									name: promptText(view.label),
								})}
								confirmLabel={t("Revert to the file version")}
								tone="danger"
								onConfirm={async () => {
									try {
										const reverted = await editApi.revertPrompt(id, {
											base: view.text,
										});
										setView(reverted);
										setDraft(reverted.text);
										setReviewing(false);
										toast(t("Back to the file version."));
									} catch (failure) {
										if (
											!(failure instanceof ApiFailure && failure.status === 409)
										)
											throw failure;
										// Someone saved first: the page shows what is there now, and the revert is asked for again.
										const { current } = failure.body as { current: PromptView };
										setView(current);
										toast(failure.message, "danger");
									}
								}}
								onClose={() => setReverting(false)}
							>
								<p>
									{t(
										"The text you saved is dropped and the text from the file applies from the next turn. It stays in the history, so you can bring it back.",
									)}
								</p>
							</Confirm>
						</Suspense>
					) : null}
				</div>
			) : null}
		</Sheet>
	);
}
