import { type CSSProperties, useEffect, useRef, useState } from "react";

/** How long the pop of a new message lasts; the style's `fig-pop` runs as long. */
export const POP_MS = 600;

/** A key's own phase in seconds, so figures that rest side by side do not breathe in step. */
export function phaseOf(key: string): string {
	let hash = 0;
	for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return `-${((hash % 30) / 10).toFixed(1)}s`;
}

/**
 * What a figure of the chat home does, as attributes for the style to animate by transform alone:
 * `data-pop` is there for one pop after a new unread message, and `--phase` offsets its loops. The
 * state it shows is on the figure's host. One timer ends a pop; nothing runs per frame.
 */
export function useFigureMotion(
	key: string,
	unread: number,
): {
	"data-pop"?: "";
	style: CSSProperties;
} {
	const seen = useRef(unread);
	const [popping, setPopping] = useState(false);
	useEffect(() => {
		const more = unread > seen.current;
		seen.current = unread;
		if (!more) return;
		setPopping(true);
		const timer = setTimeout(() => setPopping(false), POP_MS);
		return () => clearTimeout(timer);
	}, [unread]);
	return {
		...(popping ? { "data-pop": "" as const } : {}),
		style: { "--phase": phaseOf(key) } as CSSProperties,
	};
}
