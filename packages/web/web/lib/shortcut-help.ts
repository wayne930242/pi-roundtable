// The sheet that lists the keyboard shortcuts. The `?` key asks for it with `openShortcutHelp`, and
// `ShortcutHelpHost` (mounted once, in the app) draws it; its drawing loads with the first ask.

import { signal } from "./signal.ts";

let shown = false;
const { emit, use } = signal();

export function openShortcutHelp(): void {
	if (shown) return;
	shown = true;
	emit();
}

export function closeShortcutHelp(): void {
	if (!shown) return;
	shown = false;
	emit();
}

export const useShortcutHelp = (): boolean => use(() => shown);

/** Whether the sheet is open. */
export const shortcutHelpOpen = (): boolean => shown;

/** Whether the keys are named the way an Apple keyboard prints them: ⌘ and ⌥ rather than Ctrl and Alt. */
export const appleKeys = (): boolean =>
	typeof navigator !== "undefined" &&
	/Mac|iPhone|iPad/.test(navigator.platform);
