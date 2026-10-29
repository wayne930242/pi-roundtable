import { signal } from "./signal.ts";

// Arrange mode: the room list shows a menu button beside each row. A page-wide flag, off at every start.
let arranging = false;
const { emit, use } = signal();

export const useArranging = (): boolean => use(() => arranging);
export const isArranging = (): boolean => arranging;

export function setArranging(next: boolean): void {
	if (arranging === next) return;
	arranging = next;
	emit();
}
