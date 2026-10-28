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
import { size as bytes } from "../lib/format.ts";
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
	upload?: UploadView;
	failed?: string;
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
	const [files, setFiles] = useState<Attached[]>([]);
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
		for (const file of list) {
			if (limits && file.size > limits.maxBytes) {
				toast(
					t("{name} is over the {limit} limit.", {
						name: file.name,
						limit: bytes(limits.maxBytes),
					}),
					"danger",
				);
				continue;
			}
			if (limits && !limits.types.includes(file.type)) {
				toast(
					t("{name} is not a type the app takes.", { name: file.name }),
					"danger",
				);
				continue;
			}
			counter.current += 1;
			const key = counter.current;
			setFiles((current) => [...current, { key, name: file.name }]);
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

	// biome-ignore lint/correctness/useExhaustiveDependencies: `attach` is rebuilt each render; the dropped files are what trigger this
	useEffect(() => {
		if (!props.incoming?.length) return;
		attach(props.incoming);
		props.onIncomingTaken?.();
	}, [props.incoming]);

	const ready = files.filter((one) => one.upload);
	const waiting = files.some((one) => !one.upload && !one.failed);
	const canSend = !waiting && (text.trim() !== "" || ready.length > 0);

	const send = () => {
		if (!canSend) return;
		props.onSend(
			text.trim(),
			ready.flatMap((one) => (one.upload ? [one.upload] : [])),
		);
		setText("");
		setFiles([]);
		area.current?.focus();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (
			event.key === "Enter" &&
			!event.shiftKey &&
			!event.nativeEvent.isComposing &&
			!touchPrimary()
		) {
			event.preventDefault();
			send();
		}
	};

	const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
		const pasted = [...event.clipboardData.files];
		if (pasted.length === 0) return;
		event.preventDefault();
		attach(pasted);
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
							data-state={
								one.failed ? "failed" : one.upload ? "ready" : "uploading"
							}
							title={one.failed}
						>
							<Icon name="file" size={14} />
							<span>{one.name}</span>
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
					accept={limits?.types.join(",")}
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
