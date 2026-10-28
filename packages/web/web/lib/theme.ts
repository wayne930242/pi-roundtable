import { PAGE_COLORS } from "../../src/page-colors.ts";
import { signal } from "./signal.ts";

/** What the person picked: a scheme, or whatever the system prefers. */
export type ThemePreference = "system" | "light" | "dark";

const KEY = "rt-theme";
const PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

const { emit, use } = signal();
let preference: ThemePreference = read();

function read(): ThemePreference {
	try {
		const stored = localStorage.getItem(KEY);
		return PREFERENCES.find((value) => value === stored) ?? "system";
	} catch {
		// Storage can be off (private mode); the system's scheme then decides.
		return "system";
	}
}

const systemDark = (): MediaQueryList | undefined =>
	typeof matchMedia === "function"
		? matchMedia("(prefers-color-scheme: dark)")
		: undefined;

/** The scheme the page shows now. */
function resolvedTheme(): "light" | "dark" {
	if (preference !== "system") return preference;
	return systemDark()?.matches ? "dark" : "light";
}

/** The page's background in a look and scheme, which the browser's toolbar takes. */
export const themeColorOf = (
	look: "modern" | "camelot",
	scheme: "light" | "dark",
): string => PAGE_COLORS[look][scheme];

/**
 * Puts the toolbar colour for the page's look and scheme on the `theme-color` tags. With the
 * system's scheme each tag keeps the scheme its media query names; a pick sets them all.
 */
export function paintThemeColor(): void {
	requestAnimationFrame(() => {
		const look =
			document.documentElement.dataset.look === "camelot"
				? "camelot"
				: "modern";
		let metas = [
			...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
		];
		if (metas.length === 0) {
			const meta = document.createElement("meta");
			meta.name = "theme-color";
			document.head.append(meta);
			metas = [meta];
		}
		for (const meta of metas) {
			const media = meta.getAttribute("media") ?? "";
			const named = media.includes("dark") ? "dark" : "light";
			meta.content = themeColorOf(
				look,
				preference === "system" && media ? named : resolvedTheme(),
			);
		}
	});
}

function apply(): void {
	const root = document.documentElement;
	if (preference === "system") delete root.dataset.theme;
	else root.dataset.theme = preference;
	paintThemeColor();
	emit();
}

/**
 * Applies the stored scheme. Called first thing when the page's script runs, before React draws,
 * so the page never shows the other scheme first; the CSS already follows the system's scheme.
 */
export function initTheme(): void {
	apply();
	systemDark()?.addEventListener("change", () => {
		if (preference === "system") apply();
	});
}

const reduced = () =>
	typeof matchMedia === "function" &&
	matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Switches the scheme. Where the browser has view transitions, the new scheme grows out of
 * `origin` (the button that was pressed) as a circle; elsewhere the colors fade.
 */
export function setTheme(
	next: ThemePreference,
	origin?: { x: number; y: number },
): void {
	if (next === preference) return;
	preference = next;
	try {
		localStorage.setItem(KEY, next);
	} catch {
		// The choice then lasts until the page closes.
	}
	const root = document.documentElement;
	if (reduced()) {
		apply();
		return;
	}
	if (typeof document.startViewTransition === "function") {
		const x = origin?.x ?? innerWidth / 2;
		const y = origin?.y ?? innerHeight / 2;
		const radius = Math.hypot(
			Math.max(x, innerWidth - x),
			Math.max(y, innerHeight - y),
		);
		root.classList.add("theme-reveal");
		const transition = document.startViewTransition(apply);
		transition.ready
			.then(() =>
				root.animate(
					{
						clipPath: [
							`circle(0 at ${x}px ${y}px)`,
							`circle(${radius}px at ${x}px ${y}px)`,
						],
					},
					{
						duration: 480,
						easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
						pseudoElement: "::view-transition-new(root)",
					},
				),
			)
			.catch(() => undefined);
		transition.updateCallbackDone.catch(() => undefined);
		transition.finished
			.catch(() => undefined)
			.finally(() => root.classList.remove("theme-reveal"));
		return;
	}
	root.classList.add("theme-fade");
	apply();
	setTimeout(() => root.classList.remove("theme-fade"), 260);
}

/** The person's pick and the scheme it comes to now. */
export function useTheme(): {
	preference: ThemePreference;
	resolved: "light" | "dark";
} {
	return { preference: use(() => preference), resolved: resolvedTheme() };
}
