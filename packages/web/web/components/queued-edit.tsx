import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import type { RoomMessage } from "../../src/api-types.ts";
import { translate as t } from "../lib/messages.ts";
import { editQueued } from "../lib/queued-actions.ts";
import { clearQueuedEdit, useQueuedEdit } from "../lib/queued-edit.ts";
import { Dialog } from "./dialog.tsx";

/** The text of a waiting message. It mounts when the sheet opens, so each time starts from the message. */
function EditForm(props: { message: RoomMessage; onClose(): void }) {
	const { message } = props;
	const [text, setText] = useState(message.text);
	const field = useRef<HTMLTextAreaElement>(null);
	// The sheet's first control is its close button; the text is what the person came to change.
	useEffect(() => {
		field.current?.focus();
		field.current?.setSelectionRange(text.length, text.length);
	}, [text.length]);
	const clean = text.trim();
	const blank = clean === "" && message.files.length === 0;
	const submit = (event: SyntheticEvent) => {
		event.preventDefault();
		if (blank) return;
		// A turn that started meanwhile is told to the person by the refusal that comes back.
		if (clean !== message.text) editQueued(message, clean);
		props.onClose();
	};
	return (
		<form className="stack" onSubmit={submit}>
			<div className="field">
				<textarea
					ref={field}
					className="queued-edit-text"
					rows={6}
					value={text}
					aria-label={t("Edit")}
					onChange={(event) => setText(event.target.value)}
				/>
			</div>
			<div className="actions">
				<button type="button" className="secondary" onClick={props.onClose}>
					{t("Cancel")}
				</button>
				<button type="submit" disabled={blank}>
					{t("Save")}
				</button>
			</div>
		</form>
	);
}

/** Draws the form that `askQueuedEdit` asks for, wherever in the page it was asked. */
export function QueuedEditHost() {
	const ask = useQueuedEdit();
	const last = useRef<RoomMessage | undefined>(undefined);
	if (ask) last.current = ask;
	const shown = last.current;
	if (!shown) return null;
	return (
		<Dialog
			open={ask !== undefined}
			title={t("Edit")}
			onClose={clearQueuedEdit}
		>
			<EditForm key={shown.id} message={shown} onClose={clearQueuedEdit} />
		</Dialog>
	);
}
