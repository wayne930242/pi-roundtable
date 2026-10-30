import { signal } from "./signal.ts";

/** A short notice that fades away by itself. */
export interface Toast {
	id: number;
	text: string;
	tone: "info" | "danger";
	/** A button beside the words: the undo of what the notice reports. */
	action?: { label: string; run(): void };
}

let toasts: readonly Toast[] = [];
let next = 1;
const { emit, use } = signal();
const TOAST_MS = 5200;

/** Shows a notice; with an `action` it carries a button, and pressing it ends the notice. */
export function toast(
	text: string,
	tone: Toast["tone"] = "info",
	action?: Toast["action"],
): void {
	const id = next++;
	toasts = [
		...toasts.slice(-2),
		{ id, text, tone, ...(action ? { action } : {}) },
	];
	emit();
	setTimeout(() => dismissToast(id), TOAST_MS);
}

export function dismissToast(id: number): void {
	toasts = toasts.filter((one) => one.id !== id);
	emit();
}

export const useToasts = (): readonly Toast[] => use(() => toasts);
