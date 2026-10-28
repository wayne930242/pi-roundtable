import { useSyncExternalStore } from "react";

/** What the person picked: a scheme, or whatever the system prefers. */
export type ThemePreference = "system" | "light" | "dark";

const KEY = "rt-theme";
const PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

const listeners = new Set<() => void>();
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
export function resolvedTheme(): "light" | "dark" {
	if (preference !== "system") return preference;
	return systemDark()?.matches ? "dark" : "light";
}

function paintMeta(): void {
	// The browser bar takes the page's own background once the scheme has been applied. With the
	// system's scheme each tag keeps the colour the server gave its media query; a pick of the
	// other scheme sets them all.
	requestAnimationFrame(() => {
		const metas = document.querySelectorAll<HTMLMetaElement>(
			'meta[name="theme-color"]',
		);
		if (metas.length === 0) {
			const meta = document.createElement("meta");
			meta.name = "theme-color";
			document.head.append(meta);
			meta.content = getComputedStyle(document.body).backgroundColor;
			return;
		}
		const explicit = getComputedStyle(document.body).backgroundColor;
		for (const meta of metas) {
			meta.dataset.system ??= meta.content;
			meta.content = preference === "system" ? meta.dataset.system : explicit;
		}
	});
}

function apply(): void {
	const root = document.documentElement;
	if (preference === "system") delete root.dataset.theme;
	else root.dataset.theme = preference;
	paintMeta();
	for (const listener of listeners) listener();
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

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

/** The person's pick and the scheme it comes to now. */
export function useTheme(): {
	preference: ThemePreference;
	resolved: "light" | "dark";
} {
	const current = useSyncExternalStore(
		subscribe,
		() => preference,
		() => preference,
	);
	return { preference: current, resolved: resolvedTheme() };
}
