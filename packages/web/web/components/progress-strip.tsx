import { useState } from "react";
import { useLook } from "../lib/look.ts";
import { plural, translate as t } from "../lib/messages.ts";
import type { Progress } from "../lib/rooms.ts";

// Six strokes read as runes; they are drawn, not typed, so no font has to carry them.
const RUNES = [
	"M2 15V1M2 5L8 1M2 9L8 5",
	"M2 15V1L8 5V15",
	"M2 15V1M2 4H5L8 7L5 10H2",
	"M2 15V1M2 5L8 1M2 10L8 6",
	"M2 15V1H5L8 4L5 7H2M5 7L8 15",
	"M7 2L3 8L7 14",
] as const;

/** The Camelot strip's ornament: a candle that flickers and runes that shimmer one after the other while the turn works. */
function Candle() {
	return (
		<span className="candle-runes" aria-hidden="true">
			<svg
				className="candle"
				viewBox="0 0 12 22"
				aria-hidden="true"
				focusable="false"
			>
				<path
					className="candle-flame"
					d="M6 1C8.4 4.2 8.8 6.4 6 9C3.2 6.4 3.6 4.2 6 1Z"
				/>
				<path className="candle-wick" d="M6 8.6V10.4" />
				<rect
					className="candle-wax"
					x="3.5"
					y="10.4"
					width="5"
					height="10.6"
					rx="1"
				/>
			</svg>
			<span className="runes">
				{RUNES.map((path, index) => (
					<svg
						// biome-ignore lint/suspicious/noArrayIndexKey: the six strokes never reorder
						key={index}
						className="rune"
						aria-hidden="true"
						viewBox="0 0 10 16"
						focusable="false"
						data-rune={index}
					>
						<path d={path} />
					</svg>
				))}
			</span>
		</span>
	);
}

/** How many of the newest tool calls a folded strip shows. */
export const LATEST_TOOLS = 3;

/** The tool calls a strip shows: the newest few while folded, every one when opened. */
export function shownTools<T>(
	tools: readonly T[],
	all: boolean,
): { shown: readonly T[]; hidden: number } {
	if (all || tools.length <= LATEST_TOOLS) return { shown: tools, hidden: 0 };
	return {
		shown: tools.slice(-LATEST_TOOLS),
		hidden: tools.length - LATEST_TOOLS,
	};
}

/** What the running turn shows: a shimmering bar, its streamed words with a caret, and the tools it runs. */
export function ProgressStrip(props: { name: string; progress: Progress }) {
	const [expanded, setExpanded] = useState(false);
	const [allTools, setAllTools] = useState(false);
	const { text, tools } = props.progress;
	const { shown, hidden } = shownTools(tools, allTools);
	const camelot = useLook() === "camelot";
	return (
		<div className="progress" aria-live="off">
			<div className="progress-head">
				{camelot ? <Candle /> : null}
				<span className="progress-bar" aria-hidden="true" />
				<span className="progress-label">
					{t("{name} is working…", { name: props.name })}
				</span>
			</div>
			{tools.length ? (
				<ul className="chips">
					{hidden > 0 || allTools ? (
						<li className="chip-more-item">
							<button
								type="button"
								className="chip chip-more"
								aria-expanded={allTools}
								onClick={() => setAllTools((value) => !value)}
							>
								{allTools
									? t("Show fewer tools")
									: plural(
											hidden,
											"{count} earlier tool",
											"{count} earlier tools",
										)}
							</button>
						</li>
					) : null}
					{shown.map((chip) => (
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
					<span className="progress-flow">
						{text}
						<span className="caret" aria-hidden="true" />
					</span>
				</button>
			) : null}
		</div>
	);
}
