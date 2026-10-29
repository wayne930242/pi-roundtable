import {
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useRef,
} from "react";
import { translate as t } from "../lib/messages.ts";
import { reducedMotion } from "../lib/motion.ts";
import { Icon } from "./icons.tsx";

/** How far a drag must go, or how fast it must be, to dismiss the sheet. */
const DISMISS_DISTANCE = 96;
const DISMISS_VELOCITY = 0.6;
const CLOSE_MS = 220;

const compact = () =>
	typeof matchMedia === "function" && matchMedia("(max-width: 719px)").matches;

/**
 * A modal that rises from the bottom edge on a phone, where it can be dragged down to dismiss, and
 * sits in the middle of the screen elsewhere. It is the browser's own `<dialog>`, so focus stays
 * inside it and Escape closes it; the opening and closing are animated on `transform` and `opacity`.
 */
export function Sheet(props: {
	open: boolean;
	title: string;
	onClose(): void;
	children: ReactNode;
	/** `palette` is a wide, top-aligned panel for the room switcher. */
	variant?: "sheet" | "palette";
	/** `wide` is a reading width, for a document; `full` fills the window, for writing at length. */
	size?: "default" | "wide" | "full";
	/** Where focus goes once the sheet is gone, when the browser's own return would land on nothing. */
	restoreFocus?(): HTMLElement | null;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	const drag = useRef<{ y: number; at: number; dy: number } | undefined>(
		undefined,
	);
	const { open, onClose } = props;
	const restoreFocus = useRef(props.restoreFocus);
	restoreFocus.current = props.restoreFocus;
	const closing = useRef(false);
	/** The parent closed it already, so the closing animation reports nothing back. */
	const quiet = useRef(false);

	const finish = useCallback(() => {
		const dialog = ref.current;
		if (dialog?.open) dialog.close();
		restoreFocus.current?.()?.focus();
		closing.current = false;
		if (quiet.current) quiet.current = false;
		else onClose();
	}, [onClose]);

	/** Animates out, then closes. */
	const dismiss = useCallback(() => {
		const dialog = ref.current;
		if (!dialog || closing.current) return;
		closing.current = true;
		if (reducedMotion()) {
			finish();
			return;
		}
		dialog.dataset.state = "closing";
		dialog.style.removeProperty("transform");
		setTimeout(finish, CLOSE_MS);
	}, [finish]);

	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		if (open && !dialog.open) {
			dialog.dataset.state = "opening";
			dialog.showModal();
			// The next frame lets the opening state paint, so the change to `open` animates.
			requestAnimationFrame(() =>
				requestAnimationFrame(() => {
					dialog.dataset.state = "open";
				}),
			);
		}
		// Closed from outside, for instance after Confirm: it still slides away rather than vanishing.
		if (!open && dialog.open && !closing.current) {
			quiet.current = true;
			dismiss();
		}
	}, [open, dismiss]);

	const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
		if (!compact()) return;
		// A button in the header is pressed, not dragged.
		if (event.target instanceof Element && event.target.closest("button, a"))
			return;
		drag.current = { y: event.clientY, at: event.timeStamp, dy: 0 };
		event.currentTarget.setPointerCapture(event.pointerId);
		const dialog = ref.current;
		if (dialog) dialog.dataset.dragging = "true";
	};
	const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
		const current = drag.current;
		const dialog = ref.current;
		if (!current || !dialog) return;
		const dy = Math.max(0, event.clientY - current.y);
		current.dy = dy;
		dialog.style.transform = `translate3d(0, ${dy}px, 0)`;
		dialog.style.setProperty(
			"--sheet-progress",
			String(1 - Math.min(1, dy / 400)),
		);
	};
	const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
		const current = drag.current;
		const dialog = ref.current;
		drag.current = undefined;
		if (!current || !dialog) return;
		delete dialog.dataset.dragging;
		const velocity = current.dy / Math.max(1, event.timeStamp - current.at);
		if (current.dy > DISMISS_DISTANCE || velocity > DISMISS_VELOCITY) {
			dismiss();
			return;
		}
		dialog.style.removeProperty("transform");
		dialog.style.removeProperty("--sheet-progress");
	};

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: a click on the backdrop is a pointer shortcut; Escape closes the dialog through onCancel
		<dialog
			ref={ref}
			className={
				props.variant === "palette"
					? "sheet palette"
					: props.size === "wide"
						? "sheet wide"
						: props.size === "full"
							? "sheet full"
							: "sheet"
			}
			aria-label={props.title}
			// `cancel` and `close` rise through the React tree: a sheet inside a sheet must not close its parent.
			onCancel={(event) => {
				if (event.target !== event.currentTarget) return;
				event.preventDefault();
				dismiss();
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget) dismiss();
			}}
			onClose={(event) => {
				if (event.target !== event.currentTarget) return;
				if (!closing.current) onClose();
			}}
		>
			<div
				className="sheet-grab"
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={onPointerUp}
			>
				<span className="sheet-handle" />
			</div>
			{props.variant === "palette" ? null : (
				<div
					className="sheet-head"
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={onPointerUp}
				>
					<h2 title={props.title}>{props.title}</h2>
					<button
						type="button"
						className="icon-button"
						aria-label={t("Close")}
						onClick={dismiss}
					>
						<Icon name="close" />
					</button>
				</div>
			)}
			<div className="sheet-body">{open ? props.children : null}</div>
		</dialog>
	);
}
