import { signal } from "./signal.ts";

// Whether a row or folder is lifted now. The lists keep their order while it is, so an incoming
// message does not move rows under the finger; they follow the latest order once it is dropped.
let lifted = false;
const { emit, use } = signal();

export const useLifting = (): boolean => use(() => lifted);

export function setLifting(next: boolean): void {
	if (lifted === next) return;
	lifted = next;
	emit();
}
