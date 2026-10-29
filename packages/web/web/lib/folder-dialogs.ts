import { signal } from "./signal.ts";

/** A question or form about folders, asked from a menu and drawn once for the whole page. */
export type FolderDialog =
	/** A folder with a name; when `room` is given, that room goes into it. */
	| { kind: "new"; room?: string }
	| { kind: "rename"; id: string; name: string }
	| { kind: "delete"; id: string; name: string }
	/** Where a room goes: a folder, none, or a new folder. */
	| { kind: "move"; room: string };

let current: FolderDialog | undefined;
const { emit, use } = signal();

/** Opens the dialog; `FolderDialogHost` draws it. */
export function askFolderDialog(ask: FolderDialog): void {
	current = ask;
	emit();
}

export function clearFolderDialog(): void {
	if (!current) return;
	current = undefined;
	emit();
}

export const useFolderDialog = (): FolderDialog | undefined =>
	use(() => current);
