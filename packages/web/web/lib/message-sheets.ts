// The sheets a message opens over the room: a room's archived conversation, and a message's text
// to select from. A row or a menu asks for one with an `open…` call, and the hosts in
// `sheet-hosts.tsx` (mounted once, in the app) draw it. Only lazy chunks import this, so its calls
// stay out of what the page loads first.

import type { MessagesView } from "../../src/api-types.ts";
import { request } from "./api.ts";
import { signal } from "./signal.ts";

export const archivedApi = {
	/** A page of the conversation the room's start-over line `until` ended, older than `before`. */
	page: (room: string, until: number, before?: number, limit = 50) =>
		request<MessagesView>(
			`rooms/${encodeURIComponent(room)}/messages?archive=${until}&limit=${limit}${
				before === undefined ? "" : `&before=${before}`
			}`,
		),
};

/** The conversation a start-over ended: the room, and the id of the start-over line that ended it. */
export interface ArchivedRequest {
	room: string;
	until: number;
}

let archived: ArchivedRequest | undefined;
const { emit, use } = signal();

/** Opens the archived conversation that the start-over line `until` of the room ended. */
export function openArchived(room: string, until: number): void {
	archived = { room, until };
	emit();
}

export function closeArchived(): void {
	if (!archived) return;
	archived = undefined;
	emit();
}

export const useArchived = (): ArchivedRequest | undefined =>
	use(() => archived);

/** A message's text, shown alone so the platform's own selection works on it. */
export interface SelectTextRequest {
	author: string;
	text: string;
}

let selecting: SelectTextRequest | undefined;

/** Opens the sheet that shows a message's text to select from. */
export function openSelectText(author: string, text: string): void {
	selecting = { author, text };
	emit();
}

export function closeSelectText(): void {
	if (!selecting) return;
	selecting = undefined;
	emit();
}

export const useSelectText = (): SelectTextRequest | undefined =>
	use(() => selecting);
