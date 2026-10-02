import { fileURLToPath } from "node:url";
import { registerFont } from "canvas";

/** The family the bundled font is registered under; canvas needs it before the first draw. */
export const FONT_FAMILY = "Roundtable Drawing Sans";

const FONT_FILE = fileURLToPath(
	new URL("../fonts/NotoSansTC-Bold.otf", import.meta.url),
);

/** The dark ground, the teal accents, and the text colors of the magic drawings and card spreads. */
export const PALETTE = {
	background: "#111a1c",
	surface: "#1a2628",
	accent: "#1f7a72",
	accentLight: "#5fc4b8",
	text: "#f2f5f4",
	muted: "#6f8583",
} as const;

let registered = false;

/** Registers the bundled font once per process. */
export function ensureFont(): void {
	if (registered) return;
	registerFont(FONT_FILE, { family: FONT_FAMILY, weight: "bold" });
	registered = true;
}

/** A canvas font string in the bundled family. */
export const font = (px: number): string => `bold ${px}px "${FONT_FAMILY}"`;
