import { useCallback, useEffect, useState } from "react";
import type { NoteInput, NoteKind, NoteView } from "../../src/api-types.ts";
import { Dialog } from "../components/dialog.tsx";
import { Badge, Empty, Failure, Loading } from "../components/states.tsx";
import { api, messageOf } from "../lib/api.ts";
import { useConfig } from "../lib/config.ts";
import { today } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";

const KINDS: { kind: NoteKind; label: string; hint: string }[] = [
	{ kind: "core", label: "Core", hint: "Carried into every turn." },
	{
		kind: "note",
		label: "Notes",
		hint: "Searched when the assistant needs them.",
	},
	{
		kind: "event",
		label: "Events",
		hint: "Carried into every turn until their date.",
	},
];

const SEARCH_DELAY_MS = 300;

interface Draft {
	kind: NoteKind;
	fact: string;
	eventDate: string;
}

/** What the editor is doing: adding a note, or changing one. */
type Editing = { note?: NoteView; draft: Draft };

export function NotesPage() {
	const { timeZone } = useConfig();
	const { version } = useLive();
	const [kind, setKind] = useState<NoteKind>("core");
	const [query, setQuery] = useState("");
	const [notes, setNotes] = useState<NoteView[]>();
	const [error, setError] = useState<string>();
	const [editing, setEditing] = useState<Editing>();
	const [deleting, setDeleting] = useState<NoteView>();

	const load = useCallback(async (search: string) => {
		try {
			setNotes(await api.notes(search.trim()));
			setError(undefined);
		} catch (failure) {
			setError(messageOf(failure));
		}
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the version moves whenever the server reports a change
	useEffect(() => {
		const timer = setTimeout(() => void load(query), SEARCH_DELAY_MS);
		return () => clearTimeout(timer);
	}, [query, load, version]);

	const shown = (notes ?? [])
		.filter((note) => note.kind === kind)
		.sort((a, b) =>
			kind === "event"
				? (a.eventDate ?? "").localeCompare(b.eventDate ?? "")
				: a.id - b.id,
		);
	const todayDate = today(timeZone);

	return (
		<section className="stack">
			<div className="card-head">
				<div>
					<h2>Notes</h2>
					<p className="hint">
						What the assistant remembers. A change applies from the next turn.
					</p>
				</div>
				<button
					type="button"
					onClick={() =>
						setEditing({ draft: { kind, fact: "", eventDate: "" } })
					}
				>
					Add
				</button>
			</div>
			<div className="toolbar">
				<div className="tabs" role="tablist">
					{KINDS.map((entry) => (
						<button
							key={entry.kind}
							type="button"
							role="tab"
							aria-selected={kind === entry.kind}
							onClick={() => setKind(entry.kind)}
						>
							{entry.label}
							{notes
								? ` ${notes.filter((n) => n.kind === entry.kind).length}`
								: ""}
						</button>
					))}
				</div>
				<input
					type="search"
					placeholder="Search (words separated by spaces)"
					aria-label="Search notes"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
			</div>
			<p className="hint">{KINDS.find((entry) => entry.kind === kind)?.hint}</p>
			{error ? <Failure message={error} /> : null}
			{!notes ? (
				<Loading />
			) : shown.length === 0 ? (
				<Empty>
					{query ? "No matching notes." : "Nothing of this kind yet."}
				</Empty>
			) : (
				shown.map((note) => (
					<article key={note.id} className="card">
						<div className="card-head">
							<div>
								{note.eventDate ? (
									<p className="meta">
										{note.eventDate}{" "}
										{note.eventDate < todayDate ? <Badge>past</Badge> : null}
									</p>
								) : null}
								<p className="text">{note.fact}</p>
							</div>
							<div className="actions">
								<button
									type="button"
									className="secondary"
									onClick={() =>
										setEditing({
											note,
											draft: {
												kind: note.kind,
												fact: note.fact,
												eventDate: note.eventDate ?? "",
											},
										})
									}
								>
									Edit
								</button>
								<button
									type="button"
									className="danger"
									onClick={() => setDeleting(note)}
								>
									Delete
								</button>
							</div>
						</div>
					</article>
				))
			)}
			<Dialog
				open={editing !== undefined}
				title={editing?.note ? "Edit note" : "Add note"}
				onClose={() => setEditing(undefined)}
			>
				{editing ? (
					<NoteEditor
						initial={editing.draft}
						save={async (input) => {
							if (editing.note) await api.updateNote(editing.note.id, input);
							else await api.addNote(input);
							setEditing(undefined);
							await load(query);
						}}
						cancel={() => setEditing(undefined)}
					/>
				) : null}
			</Dialog>
			<Dialog
				open={deleting !== undefined}
				title="Delete this note?"
				onClose={() => setDeleting(undefined)}
			>
				{deleting ? (
					<Confirm
						text={deleting.fact}
						run={async () => {
							await api.deleteNote(deleting.id);
							setDeleting(undefined);
							await load(query);
						}}
						cancel={() => setDeleting(undefined)}
					/>
				) : null}
			</Dialog>
		</section>
	);
}

function NoteEditor(props: {
	initial: Draft;
	save(input: NoteInput): Promise<void>;
	cancel(): void;
}) {
	const [draft, setDraft] = useState(props.initial);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string>();

	const submit = async () => {
		setSaving(true);
		setError(undefined);
		try {
			await props.save({
				kind: draft.kind,
				fact: draft.fact,
				...(draft.kind === "event" && draft.eventDate
					? { eventDate: draft.eventDate }
					: {}),
			});
		} catch (failure) {
			setError(messageOf(failure));
			setSaving(false);
		}
	};

	return (
		<form
			className="stack"
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<fieldset>
				<legend>Kind</legend>
				<div className="tabs">
					{KINDS.map((entry) => (
						<button
							key={entry.kind}
							type="button"
							aria-pressed={draft.kind === entry.kind}
							onClick={() => setDraft({ ...draft, kind: entry.kind })}
						>
							{entry.label}
						</button>
					))}
				</div>
			</fieldset>
			{draft.kind === "event" ? (
				<label>
					Date
					<input
						type="date"
						value={draft.eventDate}
						onChange={(event) =>
							setDraft({ ...draft, eventDate: event.target.value })
						}
					/>
				</label>
			) : null}
			<label>
				Text
				<textarea
					rows={4}
					value={draft.fact}
					onChange={(event) => setDraft({ ...draft, fact: event.target.value })}
				/>
			</label>
			{error ? <Failure message={error} /> : null}
			<div className="actions">
				<button type="button" className="secondary" onClick={props.cancel}>
					Cancel
				</button>
				<button type="submit" disabled={saving}>
					{saving ? "Saving…" : "Save"}
				</button>
			</div>
		</form>
	);
}

function Confirm(props: {
	text: string;
	run(): Promise<void>;
	cancel(): void;
}) {
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string>();
	return (
		<div className="stack">
			<p className="text">{props.text}</p>
			{error ? <Failure message={error} /> : null}
			<div className="actions">
				<button type="button" className="secondary" onClick={props.cancel}>
					Cancel
				</button>
				<button
					type="button"
					className="danger"
					disabled={running}
					onClick={() => {
						setRunning(true);
						props.run().catch((failure) => {
							setError(messageOf(failure));
							setRunning(false);
						});
					}}
				>
					{running ? "Deleting…" : "Delete"}
				</button>
			</div>
		</div>
	);
}
