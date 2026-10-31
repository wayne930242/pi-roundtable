import { useLayoutEffect, useRef, useState } from "react";
import type { RoomFile, RoomMessage } from "../../src/api-types.ts";
import { size } from "../lib/format.ts";
import { installStyle } from "../lib/lazy-style.ts";
import { useMenuPress } from "../lib/menu-press.ts";
import { fileMenuOf } from "../lib/menus.ts";
import { plural, translate as t } from "../lib/messages.ts";
import { reducedMotion } from "../lib/motion.ts";
import { fileUrl, messageZipUrl } from "../lib/rooms.ts";
import { Icon } from "./icons.tsx";

// A lazy chunk, with its styles, so the page's first load stays as it was before the block.
const ATTACHMENTS_CSS = `
.attachments {
	margin-top: var(--space-3);
	padding: var(--space-2);
	border: 1px solid var(--border-strong);
	border-radius: var(--radius);
	background: var(--bg);
	color: var(--text);
	min-width: 0;
	scroll-margin-top: var(--space-6);
}

.bubble > .attachments:first-child {
	margin-top: 0;
}

.attachments-head {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-height: 2rem;
	padding: 0 var(--space-1);
	font-size: var(--text-sm);
	font-weight: 600;
}

.attachments-head > span {
	flex: 1;
	min-width: 0;
}

.attachments .link-button {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	border: 1px solid transparent;
	border-radius: var(--radius);
	font-size: var(--text-sm);
	font-weight: 500;
	text-decoration: none;
	white-space: nowrap;
}

.attachments .files {
	flex-direction: column;
	flex-wrap: nowrap;
	margin-top: var(--space-1);
}

.attachments .file-chip {
	display: flex;
	width: 100%;
	box-sizing: border-box;
	min-height: 2.75rem;
	border: 1px solid var(--border);
	border-radius: var(--radius);
	background: var(--surface);
	font-family: inherit;
}

.attachments .file-chip > svg {
	flex: none;
	color: var(--accent);
}

.attachments .file-name {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.attachments .file-size {
	flex: none;
	color: var(--muted);
	font-size: var(--text-xs);
	font-variant-numeric: tabular-nums;
}

.message[data-mine] .attachments .file-chip {
	background: var(--surface);
	color: var(--text);
}

.attachments-jump {
	display: inline-flex;
	align-items: center;
	margin: 0 0 var(--space-2);
	font-size: var(--text-sm);
}

.attachments-jump[hidden] {
	display: none;
}

.message[data-mine] .attachments-jump {
	color: inherit;
	text-decoration: underline;
}
`;

/** A file of a message: a picture that opens, or a chip that downloads; a long press offers both ways to keep it. */
function FileItem({ file }: { file: RoomFile }) {
	const press = useMenuPress(() => fileMenuOf(file));
	return file.type.startsWith("image/") ? (
		<li>
			<a
				{...press}
				href={fileUrl(file)}
				target="_blank"
				rel="noreferrer noopener"
			>
				<img
					src={fileUrl(file)}
					alt={file.name}
					loading="lazy"
					decoding="async"
					className="file-image"
				/>
			</a>
		</li>
	) : (
		<li>
			<a
				{...press}
				className="file-chip"
				href={fileUrl(file)}
				download={file.name}
			>
				<Icon name="file" size={16} />
				<span className="file-name">{file.name}</span>
				<span className="file-size">{size(file.size)}</span>
			</a>
		</li>
	);
}

/**
 * A message's files as one block: a heading with their count, a way to download them all as one
 * zip when there are two or more, and each file under it. Every message's files show through it.
 */
export default function Attachments(props: {
	files: readonly RoomFile[];
	/** The stored message they belong to, which the zip of all of them is asked for by. */
	message?: Pick<RoomMessage, "room" | "id">;
}) {
	installStyle("attachments", ATTACHMENTS_CSS);
	const { files, message } = props;
	return (
		<section
			className="attachments"
			aria-label={t("Attachments ({count})", { count: files.length })}
		>
			<div className="attachments-head">
				<Icon name="attach" size={16} />
				<span>{t("Attachments ({count})", { count: files.length })}</span>
				{message && files.length >= 2 ? (
					<a className="link-button" href={messageZipUrl(message)} download>
						<Icon name="download" size={16} />
						{t("Download all")}
					</a>
				) : null}
			</div>
			<ul className="files">
				{files.map((file) => (
					<FileItem key={file.id} file={file} />
				))}
			</ul>
		</section>
	);
}

/** A bubble taller than this share of the window offers a jump to its attachments. */
const TALL_SHARE = 0.9;

/**
 * The line at the top of a bubble that takes the reader down to its attachments; it shows only
 * while the bubble is taller than about one screen.
 */
export function AttachmentsJump({ count }: { count: number }) {
	installStyle("attachments", ATTACHMENTS_CSS);
	const ref = useRef<HTMLButtonElement>(null);
	const [tall, setTall] = useState(false);
	useLayoutEffect(() => {
		const bubble = ref.current?.closest<HTMLElement>(".bubble");
		if (!bubble) return;
		const measure = () =>
			setTall(
				bubble.getBoundingClientRect().height > window.innerHeight * TALL_SHARE,
			);
		measure();
		window.addEventListener("resize", measure);
		const observer =
			typeof ResizeObserver === "function"
				? new ResizeObserver(measure)
				: undefined;
		observer?.observe(bubble);
		return () => {
			window.removeEventListener("resize", measure);
			observer?.disconnect();
		};
	}, []);
	return (
		<button
			ref={ref}
			type="button"
			className="link-button attachments-jump"
			hidden={!tall}
			onClick={(event) => {
				event.stopPropagation();
				ref.current
					?.closest(".bubble")
					?.querySelector(".attachments")
					?.scrollIntoView({
						behavior: reducedMotion() ? "auto" : "smooth",
						block: "start",
					});
			}}
		>
			{plural(count, "📎 {count} attachment", "📎 {count} attachments")}
		</button>
	);
}
