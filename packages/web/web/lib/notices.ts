import { useSyncExternalStore } from "react";
import type { NoticeView, ServerFrame } from "../../src/api-types.ts";
import { accountApi } from "./account-api.ts";
import { store } from "./app-store.ts";
import { hrefFor } from "./router.ts";
import { noticeInbox, noticeSink } from "./socket.ts";

/** The person's open notices, newest first, and the count the app icon shows. */
export interface NoticeState {
	notices: readonly NoticeView[];
	badge: number;
	/** The socket has told the page what is open; before that the bell has nothing to show. */
	known: boolean;
}

type Listener = () => void;

let state: NoticeState = { notices: [], badge: 0, known: false };
const listeners = new Set<Listener>();

const set = (next: NoticeState): void => {
	state = next;
	for (const listener of listeners) listener();
};

/** The app icon's count, where the browser lets a page set it. */
function paintBadge(count: number): void {
	const nav = navigator as Navigator & {
		setAppBadge?(count: number): Promise<void>;
		clearAppBadge?(): Promise<void>;
	};
	const done = count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.();
	done?.catch(() => undefined);
}

/**
 * Feeds the store a frame of the socket. A `notice` adds or replaces one by its tag (a notice
 * raised again moves to the top), `notice_resolved` removes it, `badge` sets the count and the app
 * icon. Every other frame is not the notices' and is ignored.
 */
export function applyNoticeFrame(frame: ServerFrame): void {
	if (frame.type === "notice") {
		const rest = state.notices.filter((n) => n.tag !== frame.notice.tag);
		const at = state.notices.findIndex((n) => n.tag === frame.notice.tag);
		// A notice already listed keeps its place unless it was raised again later.
		const kept = at >= 0 ? state.notices[at] : undefined;
		const raisedAgain = kept && kept.raisedAt !== frame.notice.raisedAt;
		const notices =
			at >= 0 && !raisedAgain
				? state.notices.map((n) =>
						n.tag === frame.notice.tag ? frame.notice : n,
					)
				: [frame.notice, ...rest];
		set({ ...state, notices, known: true });
	} else if (frame.type === "notice_resolved") {
		set({
			...state,
			notices: state.notices.filter((n) => n.tag !== frame.tag),
			known: true,
		});
	} else if (frame.type === "badge") {
		set({ ...state, badge: frame.count, known: true });
		paintBadge(frame.count);
	}
}

// A new connection is sent every open notice again, so what resolved meanwhile goes.
let connects = store.getState().connects;
store.subscribe(() => {
	const now = store.getState().connects;
	if (now === connects) return;
	connects = now;
	set({ ...state, notices: [], known: false });
});

// The frames that came before this module did are applied in order, then it takes the rest.
for (const frame of noticeInbox.splice(0)) applyNoticeFrame(frame);
noticeSink.take = applyNoticeFrame;

export function noticeState(): NoticeState {
	return state;
}

/** Forgets everything, for a page that signs out or a test. */
export function resetNotices(): void {
	set({ notices: [], badge: 0, known: false });
}

function subscribe(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useNotices(): NoticeState {
	return useSyncExternalStore(subscribe, noticeState, noticeState);
}

/** Marks a notice handled, here at once and on the server. */
export async function ackNotice(tag: string): Promise<void> {
	await accountApi.ackNotice(tag);
	set({
		...state,
		notices: state.notices.map((n) =>
			n.tag === tag ? { ...n, acked: true } : n,
		),
		badge: Math.max(
			0,
			state.badge -
				(state.notices.some((n) => n.tag === tag && n.ackable && !n.acked)
					? 1
					: 0),
		),
	});
}

/** The page a notice opens, as a router address. */
export function hrefOfNotice(open: NoticeView["open"]): string {
	if (!open) return hrefFor("notices");
	if ("room" in open) {
		const base = hrefFor("room", open.room);
		return open.message === undefined
			? base
			: `${base}?message=${open.message}`;
	}
	const base = hrefFor("p", open.page);
	const query = new URLSearchParams(open.query ?? {}).toString();
	return query ? `${base}?${query}` : base;
}
