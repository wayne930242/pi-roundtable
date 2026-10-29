import { useEffect, useState } from "react";
import type { WorkspaceMedia } from "../../src/api-types.ts";
import { Icon } from "../components/icons.tsx";
import { size } from "../lib/format.ts";
import { translate as t } from "../lib/messages.ts";
import { rawHref } from "../lib/workspace-api.ts";

// What the file view shows for a file that is not text the editor takes: a picture, a PDF, a sound or
// a video from the `raw` route, and for anything else a card with the way to download it. Every address
// is the pane's own `raw` route, so the page's policy (`img-src`, `media-src` and `frame-src` on
// `'self'`) already allows it.

/** Download, and for something a browser can show on its own also Open in a new tab. */
function Actions(props: {
	root: string;
	path: string;
	name: string;
	open?: boolean;
}) {
	return (
		<div className="ws-media-actions">
			{props.open ? (
				<a
					className="button-link"
					href={rawHref(props.root, props.path)}
					target="_blank"
					rel="noopener"
				>
					{t("Open")}
				</a>
			) : null}
			<a
				className="button-link"
				href={rawHref(props.root, props.path, true)}
				download={props.name}
			>
				<Icon name="download" size={18} />
				{t("Download")}
			</a>
		</div>
	);
}

/** A file the pane cannot show: what it is, how big, and Download. */
export function FileCard(props: {
	root: string;
	path: string;
	name: string;
	bytes: number;
	message: string;
}) {
	const dot = props.name.lastIndexOf(".");
	const kind = dot > 0 ? props.name.slice(dot + 1).toUpperCase() : "";
	return (
		<div className="card ws-card">
			<span className="ws-card-icon" aria-hidden="true">
				<Icon name="file" size={32} />
			</span>
			<strong>{props.name}</strong>
			<span className="meta">
				{[kind, size(props.bytes)].filter(Boolean).join(" · ")}
			</span>
			<p>{props.message}</p>
			<Actions root={props.root} path={props.path} name={props.name} />
		</div>
	);
}

/** Whether this browser draws a PDF in a page; where it does not (or on a phone) a link is better. */
const drawsPdf = (phone: boolean): boolean =>
	!phone &&
	(navigator as Navigator & { pdfViewerEnabled?: boolean }).pdfViewerEnabled !==
		false;

export function MediaPreview(props: {
	media: WorkspaceMedia;
	root: string;
	path: string;
	name: string;
	bytes: number;
	phone: boolean;
	/** What the page learns from the file as it loads, for the header (a picture's size in pixels). */
	onFacts(facts: string | undefined): void;
}) {
	const { media, root, path, name, bytes, phone, onFacts } = props;
	const [failed, setFailed] = useState(false);
	const [actual, setActual] = useState(false);
	// A different file starts afresh.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the file is the trigger
	useEffect(() => {
		setFailed(false);
		setActual(false);
		onFacts(undefined);
		return () => onFacts(undefined);
	}, [root, path]);

	const src = rawHref(root, path);
	if (failed)
		return (
			<FileCard
				root={root}
				path={path}
				name={name}
				bytes={bytes}
				message={t("This browser cannot show this file.")}
			/>
		);
	switch (media) {
		case "image":
			return (
				<div className="ws-media ws-image" data-actual={actual || undefined}>
					<button
						type="button"
						className="ws-image-toggle"
						aria-label={actual ? t("Fit to window") : t("Show at full size")}
						title={actual ? t("Fit to window") : t("Show at full size")}
						onClick={() => setActual((value) => !value)}
					>
						<img
							src={src}
							alt={name}
							onLoad={(event) => {
								const { naturalWidth, naturalHeight } = event.currentTarget;
								onFacts(
									naturalWidth > 0
										? `${naturalWidth} × ${naturalHeight}`
										: undefined,
								);
							}}
							onError={() => setFailed(true)}
						/>
					</button>
				</div>
			);
		case "pdf":
			return drawsPdf(phone) ? (
				<div className="ws-media ws-pdf-frame">
					<iframe className="ws-pdf" src={src} title={name} />
					<Actions root={root} path={path} name={name} open />
				</div>
			) : (
				<div className="ws-media">
					<div className="card ws-card">
						<span className="ws-card-icon" aria-hidden="true">
							<Icon name="file" size={32} />
						</span>
						<strong>{name}</strong>
						<span className="meta">PDF · {size(bytes)}</span>
						<Actions root={root} path={path} name={name} open />
					</div>
				</div>
			);
		case "audio":
			return (
				<div className="ws-media ws-sound">
					{/* biome-ignore lint/a11y/useMediaCaption: a file in a workspace has no captions to offer */}
					<audio
						controls
						preload="metadata"
						src={src}
						onError={() => setFailed(true)}
					/>
				</div>
			);
		case "video":
			return (
				<div className="ws-media ws-film">
					{/* biome-ignore lint/a11y/useMediaCaption: a file in a workspace has no captions to offer */}
					<video
						controls
						playsInline
						preload="metadata"
						src={src}
						onLoadedMetadata={(event) => {
							const { videoWidth, videoHeight } = event.currentTarget;
							onFacts(
								videoWidth > 0 ? `${videoWidth} × ${videoHeight}` : undefined,
							);
						}}
						onError={() => setFailed(true)}
					/>
				</div>
			);
	}
}
