// What the host-room and page API answers, shared by the server (`src/host/`) and the page (`web/`).
// Times are ISO strings. A key is `<surface>:<kind>.<id>`.

import type {
	FormSpecView,
	HostActionView,
	HostCardView,
	PictureRef,
	ReadMarkView,
	RoomMessage,
	SendWording,
} from "../api-types.ts";

/** One room of a kind, as the list shows it. */
export interface HostRoomSummaryView {
	id: string;
	key: string;
	title: string;
	subtitle?: string;
	picture?: PictureRef;
	/** ISO time of the newest message. */
	lastAt?: string;
	attention?: boolean;
	/** Messages past the viewer's read cursor; absent when none. */
	unread?: number;
}

/** `GET api/host/<kind>`: the rooms of one kind this viewer may open. */
export interface HostListView {
	kind: string;
	label: string;
	rooms: HostRoomSummaryView[];
	cursor?: string;
}

/** The header of one room: facts about it, what the viewer may do, and a banner. */
export interface HostHeaderView {
	title: string;
	fields: { label: string; value: string; link?: string }[];
	actions: HostActionView[];
	banner?: { tone: "warn" | "risk"; text: string };
}

/** `GET api/host/<kind>/<id>`: a room as it opens. */
export interface HostRoomView {
	room: string;
	kind: string;
	id: string;
	/** What this viewer may do in the room. */
	access: { send: ("note" | "turn")[]; act: boolean };
	/** The kind's own wording of the two ways to write, where it gave any. */
	wording?: SendWording;
	header: HostHeaderView;
	/** The newest messages, oldest first. */
	messages: RoomMessage[];
	more: boolean;
	cards: HostCardView[];
	/** The other readers' cursors; the viewer's own is `cursor`. */
	reads: ReadMarkView[];
	/** The viewer's own read cursor before they opened the room; absent when they never read it. */
	cursor?: number;
}

/** `GET api/host/<kind>/<id>/messages`: a page of older messages. */
export interface HostMessagesView {
	messages: RoomMessage[];
	more: boolean;
	reads: ReadMarkView[];
}

/** What the page shows of a section of a host page. */
export type PageSectionView =
	| { kind: "markdown"; text: string }
	| {
			kind: "list";
			title?: string;
			rows: {
				title: string;
				subtitle?: string;
				open?: string;
				attention?: boolean;
				actions?: HostActionView[];
			}[];
	  }
	| { kind: "form"; form: FormSpecView; action: string }
	| {
			kind: "card";
			card: Omit<HostCardView, "id" | "room" | "at" | "updatedAt">;
	  };

/** `GET api/pages/<id>`. */
export interface HostPageView {
	id: string;
	title: string;
	sections: PageSectionView[];
}

/** Where the page takes a person after an action: a room (and a message in it), or a page with a query. */
export type OpenView =
	| { room: string; message?: number }
	| { page: string; query?: Record<string, string> };

/** What an action answers, for a button, a form or a page's action. */
export type HostActionResult =
	| { ok: true; notice?: string; open?: OpenView; url?: string }
	| { ok: false; error: string; field?: string };
