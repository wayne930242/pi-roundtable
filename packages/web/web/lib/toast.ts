import { useSyncExternalStore } from "react";

/** A short notice that fades away by itself. */
export interface Toast {
	id: number;
	text: string;
	tone: "info" | "danger";
}

let toasts: readonly Toast[] = [];
let next = 1;
const listeners = new Set<() => void>();
const TOAST_MS = 5200;

const emit = () => {
	for (const listener of listeners) listener();
};

/** Shows a notice. */
export function toast(text: string, tone: Toast["tone"] = "info"): void {
	const id = next++;
	toasts = [...toasts.slice(-2), { id, text, tone }];
	emit();
	setTimeout(() => dismissToast(id), TOAST_MS);
}

export function dismissToast(id: number): void {
	toasts = toasts.filter((one) => one.id !== id);
	emit();
}

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

export const useToasts = (): readonly Toast[] =>
	useSyncExternalStore(
		subscribe,
		() => toasts,
		() => toasts,
	);
