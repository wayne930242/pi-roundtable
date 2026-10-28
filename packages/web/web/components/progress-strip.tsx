import { useState } from "react";
import { translate as t } from "../lib/messages.ts";
import type { Progress } from "../lib/rooms.ts";
import { Icon } from "./icons.tsx";

/** What the running turn shows: a shimmering bar, its streamed words with a caret, and the tools it runs. */
export function ProgressStrip(props: {
	name: string;
	progress: Progress;
	stoppable: boolean;
	onStop(): void;
}) {
	const [expanded, setExpanded] = useState(false);
	const { text, tools } = props.progress;
	return (
		<div className="progress" aria-live="off">
			<div className="progress-head">
				<span className="progress-bar" aria-hidden="true" />
				<span className="progress-label">
					{t("{name} is working…", { name: props.name })}
				</span>
				{props.stoppable ? (
					<button type="button" className="link-button" onClick={props.onStop}>
						<Icon name="stop" size={14} />
						{t("Stop")}
					</button>
				) : null}
			</div>
			{tools.length ? (
				<ul className="chips">
					{tools.map((chip) => (
						<li key={chip.id} className="chip" data-status={chip.status}>
							<span className="chip-dot" aria-hidden="true" />
							<span>{chip.tool}</span>
							{chip.preview ? (
								<span className="chip-preview">{chip.preview}</span>
							) : null}
						</li>
					))}
				</ul>
			) : null}
			{text ? (
				<button
					type="button"
					className="progress-text"
					data-expanded={expanded}
					aria-expanded={expanded}
					aria-label={t("Show the whole stream")}
					onClick={() => setExpanded((value) => !value)}
				>
					{text}
					<span className="caret" aria-hidden="true" />
				</button>
			) : null}
		</div>
	);
}
