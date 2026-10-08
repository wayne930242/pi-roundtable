import { useCallback, useEffect, useRef, useState } from "react";
import type {
	NoteInput,
	NoteKind,
	NoteView,
	PrincipalsView,
} from "../../src/api-types.ts";
import { Dialog } from "../components/dialog.tsx";
import { Badge, Empty, Failure, Loading } from "../components/states.tsx";
import { api, messageOf } from "../lib/api.ts";
import { useConfig } from "../lib/config.ts";
import { today } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";
import { translate as t } from "../lib/messages.ts";
import { useFetched } from "../lib/use-fetched.ts";

const KINDS: { kind: NoteKind; label: string; hint: string }[] = [
	{ kind: "core", label: "Core", hint: "Carried into every turn." },
	{
		kind: "note",
		label: "Note",
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
	// Whose notes are shown: undefined for the visitor's own.
	const [principal, setPrincipal] = useState<string>();
	const people = useFetched(() => api.principals(), "principals").data;

	// Only the newest request may set the list, so a slow answer for an earlier search never replaces it.
	const latest = useRef(0);
	const load = useCallback(
		async (search: string) => {
			const request = ++latest.current;
			try {
				const loaded = await api.notes(search.trim(), principal);
				if (request !== latest.current) return;
				setNotes(loaded);
				setError(undefined);
			} catch (failure) {
				if (request === latest.current) setError(messageOf(failure));
			}
		},
		[principal],
	);

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
					<h2>{t("Notes")}</h2>
					<p className="hint">
						{t(
							"What the assistant remembers. A change applies from the next turn.",
						)}
					</p>
				</div>
				<button
					type="button"
					onClick={() =>
						setEditing({ draft: { kind, fact: "", eventDate: "" } })
					}
				>
					{t("Add")}
				</button>
			</div>
			{people && people.principals.length > 1 ? (
				<Whose
					people={people}
					shown={principal}
					choose={(chosen) => {
						setNotes(undefined);
						setPrincipal(chosen);
					}}
				/>
			) : null}
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
							{t(entry.label)}
							{notes
								? ` ${notes.filter((n) => n.kind === entry.kind).length}`
								: ""}
						</button>
					))}
				</div>
				<input
					type="search"
					placeholder={t("Search (words separated by spaces)")}
					aria-label={t("Search notes")}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
			</div>
			<p className="hint">
				{t(KINDS.find((entry) => entry.kind === kind)?.hint ?? "")}
			</p>
			{error ? <Failure message={error} /> : null}
			{!notes ? (
				<Loading />
			) : shown.length === 0 ? (
				<Empty>
					{query ? t("No matching notes.") : t("Nothing of this kind yet.")}
				</Empty>
			) : (
				shown.map((note) => (
					<article key={note.id} className="card">
						<div className="card-head">
							<div>
								{note.eventDate ? (
									<p className="meta">
										{note.eventDate}{" "}
										{note.eventDate < todayDate ? (
											<Badge>{t("past")}</Badge>
										) : null}
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
									{t("Edit")}
								</button>
								<button
									type="button"
									className="danger"
									onClick={() => setDeleting(note)}
								>
									{t("Delete")}
								</button>
							</div>
						</div>
					</article>
				))
			)}
			<Dialog
				open={editing !== undefined}
				title={editing?.note ? t("Edit note") : t("Add note")}
				onClose={() => setEditing(undefined)}
			>
				{editing ? (
					<NoteEditor
						initial={editing.draft}
						save={async (input) => {
							if (editing.note)
								await api.updateNote(editing.note.id, input, principal);
							else await api.addNote(input, principal);
							// Close only the editor this save came from, not one opened since.
							setEditing((current) =>
								current === editing ? undefined : current,
							);
							await load(query);
						}}
						cancel={() => setEditing(undefined)}
					/>
				) : null}
			</Dialog>
			<Dialog
				open={deleting !== undefined}
				title={t("Delete this note?")}
				onClose={() => setDeleting(undefined)}
			>
				{deleting ? (
					<Confirm
						text={deleting.fact}
						run={async () => {
							await api.deleteNote(deleting.id, principal);
							setDeleting((current) =>
								current === deleting ? undefined : current,
							);
							await load(query);
						}}
						cancel={() => setDeleting(undefined)}
					/>
				) : null}
			</Dialog>
		</section>
	);
}

/** Picks whose notes the pane shows, the visitor's own first. */
export function Whose(props: {
	people: PrincipalsView;
	shown: string | undefined;
	choose(principal: string | undefined): void;
}) {
	const { people } = props;
	return (
		<label className="inline">
			{t("Whose notes")}{" "}
			<select
				value={props.shown ?? people.self}
				onChange={(event) =>
					props.choose(
						event.target.value === people.self ? undefined : event.target.value,
					)
				}
			>
				{people.principals.map((person) => (
					<option key={person.id} value={person.id}>
						{person.id === people.self
							? t("{name} (you)", { name: person.name })
							: person.disabled
								? t("{name} (disabled)", { name: person.name })
								: person.name}
					</option>
				))}
			</select>
		</label>
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
				<legend>{t("Kind")}</legend>
				<div className="tabs">
					{KINDS.map((entry) => (
						<button
							key={entry.kind}
							type="button"
							aria-pressed={draft.kind === entry.kind}
							onClick={() => setDraft({ ...draft, kind: entry.kind })}
						>
							{t(entry.label)}
						</button>
					))}
				</div>
			</fieldset>
			{draft.kind === "event" ? (
				<label>
					{t("Date")}
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
				{t("Text")}
				<textarea
					rows={4}
					value={draft.fact}
					onChange={(event) => setDraft({ ...draft, fact: event.target.value })}
				/>
			</label>
			{error ? <Failure message={error} /> : null}
			<div className="actions">
				<button type="button" className="secondary" onClick={props.cancel}>
					{t("Cancel")}
				</button>
				<button type="submit" disabled={saving}>
					{saving ? t("Saving…") : t("Save")}
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
					{t("Cancel")}
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
					{running ? t("Deleting…") : t("Delete")}
				</button>
			</div>
		</div>
	);
}
