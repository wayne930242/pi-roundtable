import {
	type ChangeEvent,
	type ClipboardEvent,
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import type { UploadView } from "../../src/api-types.ts";
import { api, messageOf } from "../lib/api.ts";
import {
	firstLine,
	fitsBack,
	joinBack,
	pastedTextName,
	planFiles,
	planPaste,
	planSend,
	uploadForSend,
	usedSlots,
} from "../lib/attach.ts";
import { draftOf, keepDraft, onDraftInserted } from "../lib/drafts.ts";
import { size as bytes } from "../lib/format.ts";
import { composingKey } from "../lib/ime.ts";
import { hasLeadingAiMention } from "../lib/mention.ts";
import { translate as t } from "../lib/messages.ts";
import type { RoomsState } from "../lib/rooms.ts";
import { toast } from "../lib/toast.ts";
import { Icon } from "./icons.tsx";

/** A touch screen's keyboard has no Shift, so Enter there starts a new line and the button sends. */
const touchPrimary = () =>
	typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

interface Attached {
	key: number;
	name: string;
	size: number;
	upload?: UploadView;
	failed?: string;
	/** A long text that waits here as a file and is uploaded when the message is sent; it can be taken back into the box. */
	text?: string;
}

/**
 * The box at the foot of a room: text that grows with what is typed, files to attach, Send, and
 * Stop while a turn runs. It rides above the on-screen keyboard (the page sets `--keyboard`).
 */
export function Composer(props: {
	name: string;
	/** What the box says while it is empty and names it for a screen reader; default "Message <name>". */
	placeholder?: string;
	/** A control that belongs to the box, such as a host room's mode toggle; it stands above the bar. */
	above?: ReactNode;
	/** The room whose unsent text the box keeps: it comes back when the room is opened again. */
	draftKey?: string;
	limits: RoomsState["limits"];
	stoppable: boolean;
	/** `addressed`: the person typed `@AI` at the start of the text (see `Composer`'s note on what counts). */
	onSend(text: string, files: UploadView[], addressed: boolean): void;
	onStop(): void;
	/** Hears whether the person is addressing the agent with a leading `@AI`, as it starts and stops. */
	onAddressed?(addressed: boolean): void;
	/** Files dropped on the room come here as the composer's own. */
	incoming?: File[];
	onIncomingTaken?(): void;
}) {
	const [text, setText] = useState(() =>
		props.draftKey === undefined ? "" : draftOf(props.draftKey),
	);
	const { draftKey, onAddressed } = props;
	useEffect(() => {
		if (draftKey !== undefined) keepDraft(draftKey, text);
	}, [draftKey, text]);
	// A leading `@AI` addresses the agent only when the person typed it: a paste, a drop, a quote, a
	// kept draft or a text put back from a chip carry whatever they carry and never switch it on.
	const [addressed, setAddressed] = useState(false);
	/** The text the last typing produced; a text that differs came from somewhere else. */
	const typed = useRef(text);
	/** A paste or a drop is landing: the next input event is not typing. */
	const inserting = useRef(false);
	useEffect(() => {
		if (typed.current === text) return;
		typed.current = text;
		setAddressed(false);
	}, [text]);
	useEffect(() => {
		onAddressed?.(addressed);
	}, [onAddressed, addressed]);
	/** A quote came in from outside: the caret goes to the end of the box once it shows the text. */
	const caretToEnd = useRef(false);
	useEffect(() => {
		if (draftKey === undefined) return;
		return onDraftInserted(draftKey, (next) => {
			caretToEnd.current = true;
			setText(next);
		});
	}, [draftKey]);
	const [files, setFilesState] = useState<Attached[]>([]);
	// The newest list, so two pastes before a redraw count each other's files.
	const latest = useRef<Attached[]>([]);
	const setFiles = (change: (current: Attached[]) => Attached[]) => {
		latest.current = change(latest.current);
		setFilesState(latest.current);
	};
	const [sending, setSending] = useState(false);
	// While a send uploads, the box and the chips stay as they are: what it clears is what it sent.
	const sendingNow = useRef(false);
	const area = useRef<HTMLTextAreaElement>(null);
	const picker = useRef<HTMLInputElement>(null);
	const counter = useRef(0);
	const inputId = useId();
	const { limits } = props;

	useEffect(() => {
		const element = area.current;
		if (!element || !caretToEnd.current) return;
		caretToEnd.current = false;
		element.focus();
		element.setSelectionRange(text.length, text.length);
	}, [text]);

	// Grows with the text up to eight lines, then scrolls.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the text is what changes the height
	useEffect(() => {
		const element = area.current;
		if (!element) return;
		element.style.height = "auto";
		element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
	}, [text]);

	const attach = (list: File[]) => {
		if (sendingNow.current) return;
		const plan = planFiles(list, usedSlots(latest.current), limits);
		for (const file of plan.tooLarge)
			toast(
				t("{name} is over the {limit} limit.", {
					name: file.name,
					limit: bytes(limits?.maxBytes ?? 0),
				}),
				"danger",
			);
		if (plan.full.length > 0)
			toast(
				t("A message carries up to {count} files. Remove one to add more.", {
					count: limits?.perMessage ?? 0,
				}),
				"danger",
			);
		for (const file of plan.accepted) {
			counter.current += 1;
			const key = counter.current;
			setFiles((current) => [
				...current,
				{ key, name: file.name, size: file.size },
			]);
			api.upload(file).then(
				(upload) =>
					setFiles((current) =>
						current.map((one) => (one.key === key ? { ...one, upload } : one)),
					),
				(failure) =>
					setFiles((current) =>
						current.map((one) =>
							one.key === key ? { ...one, failed: messageOf(failure) } : one,
						),
					),
			);
		}
	};

	/** A long text waits as a file chip, to be uploaded with the message. */
	const attachText = (long: string) => {
		if (sendingNow.current) return;
		counter.current += 1;
		const key = counter.current;
		setFiles((current) => [
			...current,
			{
				key,
				name: pastedTextName(current.map((one) => one.name)),
				size: new TextEncoder().encode(long).length,
				text: long,
			},
		]);
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: `attach` is rebuilt each render; the dropped files are what trigger this
	useEffect(() => {
		if (!props.incoming?.length) return;
		attach(props.incoming);
		props.onIncomingTaken?.();
	}, [props.incoming]);

	const ready = files.filter((one) => one.upload);
	const held = files.filter((one) => one.text !== undefined);
	const waiting = files.some(
		(one) => !one.upload && !one.failed && one.text === undefined,
	);
	const canSend =
		!sending &&
		!waiting &&
		(text.trim() !== "" || ready.length > 0 || held.length > 0);

	const send = async () => {
		if (!canSend || sendingNow.current) return;
		const plan = planSend(text, usedSlots(files), limits);
		if (!plan.ok) {
			toast(
				t(
					"This message is too long to send as text, and its files take every slot. Remove one file.",
				),
				"danger",
			);
			return;
		}
		sendingNow.current = true;
		setSending(true);
		try {
			// Long texts become files now, in the order they were added, the overflow last.
			const uploads = await uploadForSend(files, plan.overflow, {
				upload: api.upload,
				discard: api.discardUpload,
			});
			props.onSend(
				plan.overflow !== undefined ? t(plan.text) : plan.text,
				uploads,
				addressed,
			);
			setText("");
			setFiles(() => []);
		} catch (failure) {
			toast(messageOf(failure), "danger");
		} finally {
			sendingNow.current = false;
			setSending(false);
			area.current?.focus();
		}
	};

	/** Takes a chip away; a file already on the server is deleted there, so it stops counting against what is waiting. */
	const removeChip = (one: Attached) => {
		if (sendingNow.current) return;
		setFiles((current) => current.filter((x) => x.key !== one.key));
		if (one.upload) api.discardUpload(one.upload.id).catch(() => undefined);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (
			event.key === "Enter" &&
			!event.shiftKey &&
			!composingKey(event.nativeEvent) &&
			!touchPrimary()
		) {
			event.preventDefault();
			send();
		}
	};

	const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
		const next = event.target.value;
		const inputType = (event.nativeEvent as InputEvent).inputType ?? "";
		const landed = inserting.current || /^insertFrom/.test(inputType);
		inserting.current = false;
		// Once the token is there it stays as it began: typed, or pasted and so ignored, until it is gone.
		setAddressed(
			hasLeadingAiMention(next) &&
				(hasLeadingAiMention(text) ? addressed : !landed),
		);
		typed.current = next;
		setText(next);
	};

	const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
		if (sendingNow.current) {
			event.preventDefault();
			return;
		}
		const plan = planPaste(
			{
				files: [...event.clipboardData.files],
				text: event.clipboardData.getData("text/plain"),
			},
			latest.current.length,
			limits,
		);
		switch (plan.kind) {
			case "insert":
				inserting.current = true;
				return;
			case "files":
				event.preventDefault();
				attach(plan.files);
				return;
			case "text":
				event.preventDefault();
				attachText(plan.text);
				return;
			case "full":
				event.preventDefault();
				toast(
					t(
						"A message carries up to {count} files, so this long text cannot be added as one. Remove a file first.",
						{ count: limits?.perMessage ?? 0 },
					),
					"danger",
				);
				return;
		}
	};

	/** A long text chip goes back into the box, when it fits there. */
	const takeBack = (one: Attached) => {
		if (one.text === undefined || sendingNow.current) return;
		if (!fitsBack(text, one.text)) {
			toast(t("It is too long to put back into the message box."), "danger");
			return;
		}
		setText((current) => joinBack(current, one.text ?? ""));
		setFiles((current) => current.filter((x) => x.key !== one.key));
		area.current?.focus();
	};

	const hint = props.placeholder ?? t("Message {name}", { name: props.name });
	return (
		<form
			className="composer"
			onSubmit={(event) => {
				event.preventDefault();
				send();
			}}
		>
			{props.above}
			{files.length ? (
				<ul className="attached">
					{files.map((one) => (
						<li
							key={one.key}
							className="attached-chip"
							data-kind={one.text === undefined ? "file" : "text"}
							data-state={
								one.failed
									? "failed"
									: one.upload || one.text !== undefined
										? "ready"
										: "uploading"
							}
							title={one.failed}
						>
							{one.text === undefined ? (
								<>
									<Icon name="file" size={14} />
									<span className="chip-body">
										<span className="chip-name">{one.name}</span>
										<span className="meta">{bytes(one.size)}</span>
									</span>
								</>
							) : (
								<button
									type="button"
									className="chip-take"
									disabled={sending}
									aria-label={t("Put {name} back into the message", {
										name: one.name,
									})}
									onClick={() => takeBack(one)}
								>
									<Icon name="file" size={14} />
									<span className="chip-body">
										<span className="chip-name">
											{one.name} · {bytes(one.size)}
										</span>
										<span className="meta">{firstLine(one.text)}</span>
									</span>
								</button>
							)}
							<button
								type="button"
								className="icon-button"
								aria-label={t("Remove {name}", { name: one.name })}
								disabled={sending}
								onClick={() => removeChip(one)}
							>
								<Icon name="close" size={14} />
							</button>
						</li>
					))}
				</ul>
			) : null}
			<div className="composer-row">
				<input
					ref={picker}
					id={inputId}
					type="file"
					multiple
					hidden
					onChange={(event) => {
						attach([...(event.target.files ?? [])]);
						event.target.value = "";
					}}
				/>
				<button
					type="button"
					className="icon-button composer-attach"
					aria-label={t("Attach a file")}
					disabled={sending}
					onClick={() => picker.current?.click()}
				>
					<Icon name="attach" />
				</button>
				<textarea
					ref={area}
					rows={1}
					value={text}
					placeholder={hint}
					aria-label={hint}
					enterKeyHint="send"
					readOnly={sending}
					onChange={onChange}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
					onDrop={() => {
						inserting.current = true;
					}}
				/>
				{props.stoppable ? (
					<button
						type="button"
						className="icon-button composer-stop"
						aria-label={t("Stop")}
						onClick={props.onStop}
					>
						<Icon name="stop" size={18} />
					</button>
				) : null}
				<button
					type="submit"
					className="composer-send"
					aria-label={t("Send")}
					disabled={!canSend}
				>
					<Icon name="send" size={20} />
				</button>
			</div>
		</form>
	);
}
