import {
	type ClipboardEvent,
	type KeyboardEvent,
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
	OVERFLOW_FILE_NAME,
	pastedTextName,
	planFiles,
	planPaste,
	planSend,
	textFile,
} from "../lib/attach.ts";
import { size as bytes } from "../lib/format.ts";
import { composingKey } from "../lib/ime.ts";
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
	limits: RoomsState["limits"];
	stoppable: boolean;
	onSend(text: string, files: UploadView[]): void;
	onStop(): void;
	/** Files dropped on the room come here as the composer's own. */
	incoming?: File[];
	onIncomingTaken?(): void;
}) {
	const [text, setText] = useState("");
	const [files, setFilesState] = useState<Attached[]>([]);
	// The newest list, so two pastes before a redraw count each other's files.
	const latest = useRef<Attached[]>([]);
	const setFiles = (change: (current: Attached[]) => Attached[]) => {
		latest.current = change(latest.current);
		setFilesState(latest.current);
	};
	const [sending, setSending] = useState(false);
	const area = useRef<HTMLTextAreaElement>(null);
	const picker = useRef<HTMLInputElement>(null);
	const counter = useRef(0);
	const inputId = useId();
	const { limits } = props;

	// Grows with the text up to eight lines, then scrolls.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the text is what changes the height
	useEffect(() => {
		const element = area.current;
		if (!element) return;
		element.style.height = "auto";
		element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
	}, [text]);

	const attach = (list: File[]) => {
		const plan = planFiles(list, latest.current.length, limits);
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
		if (!canSend) return;
		const plan = planSend(text, files.length, limits);
		if (!plan.ok) {
			toast(
				t(
					"This message is too long to send as text, and its files take every slot. Remove one file.",
				),
				"danger",
			);
			return;
		}
		setSending(true);
		try {
			// Long texts become files now, in the order they were added, the overflow last.
			const uploads: UploadView[] = [];
			for (const one of files) {
				if (one.upload) uploads.push(one.upload);
				else if (one.text !== undefined)
					uploads.push(await api.upload(textFile(one.name, one.text)));
			}
			if (plan.overflow !== undefined)
				uploads.push(
					await api.upload(textFile(OVERFLOW_FILE_NAME, plan.overflow)),
				);
			props.onSend(
				plan.overflow !== undefined ? t(plan.text) : plan.text,
				uploads,
			);
			setText("");
			setFiles(() => []);
			area.current?.focus();
		} catch (failure) {
			toast(messageOf(failure), "danger");
		} finally {
			setSending(false);
		}
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

	const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
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
		if (one.text === undefined) return;
		if (!fitsBack(text, one.text)) {
			toast(t("It is too long to put back into the message box."), "danger");
			return;
		}
		setText((current) => joinBack(current, one.text ?? ""));
		setFiles((current) => current.filter((x) => x.key !== one.key));
		area.current?.focus();
	};

	return (
		<form
			className="composer"
			onSubmit={(event) => {
				event.preventDefault();
				send();
			}}
		>
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
								onClick={() =>
									setFiles((current) =>
										current.filter((x) => x.key !== one.key),
									)
								}
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
					onClick={() => picker.current?.click()}
				>
					<Icon name="attach" />
				</button>
				<textarea
					ref={area}
					rows={1}
					value={text}
					placeholder={t("Message {name}", { name: props.name })}
					aria-label={t("Message {name}", { name: props.name })}
					enterKeyHint="send"
					onChange={(event) => setText(event.target.value)}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
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
