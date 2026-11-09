import type { ChannelKey, ServiceKey, Tier } from "pi-roundtable";
import { serviceKey } from "pi-roundtable";
import type { ChannelContext } from "pi-roundtable/discord";
import type {
	FormFieldView,
	FormSpecView,
	HostActionView,
	HostAuthorKind,
	HostIconName,
	PictureRef,
	RoomFile,
	SendWording,
} from "./api-types.ts";
import { HOST_ICONS } from "./api-types.ts";
import type { Visitor } from "./visitors.ts";

export type { HostAuthorKind, HostIconName, PictureRef, SendWording };

/** A host's icon name as the page may show it: one of `HOST_ICONS`, else none (the default shows). */
export const hostIcon = (name: unknown): HostIconName | undefined =>
	HOST_ICONS.find((icon) => icon === name);

/**
 * Who a host plugin's callbacks serve: the person behind a request or a socket frame, with the
 * tier they hold now. It is read again for every call, so a callback never sees a stale tier.
 */
export interface Viewer {
	principalId: string;
	/** The identity they signed in as, such as `oidc:<base64url issuer>:<oid>`. */
	speakerId: string;
	/** The tier they hold on this request: owner, admin or member. */
	tier: Tier;
	/** The roles their sign-in carried, each `<surface>:role:<name>` (an identity provider's app role). */
	roles: readonly string[];
	/** The name the app shows for them. */
	name: string;
}

/** A visitor the console admitted, as a plugin's callbacks see them. */
export function viewerOf(visitor: Visitor, name?: string): Viewer {
	return {
		principalId: visitor.principal.id,
		speakerId: visitor.speakerId,
		tier: visitor.tier,
		roles: visitor.roles,
		name: name ?? visitor.principal.displayName,
	};
}

// ── Rooms the host owns ────────────────────────────────────────────────────────────────────────

/** A file reference on a message a viewer sends: an id `saveFile` or an upload returned. */
export type RoomFileRef = RoomFile;

/** What a viewer may do in one host room. */
export interface RoomAccess {
	read: true;
	/** The kinds of message the viewer may send; empty = read only. */
	send: readonly ("note" | "turn")[];
	/** The viewer may press the room's buttons and run its actions. */
	act: boolean;
}

export interface HostRoomSummary {
	id: string;
	title: string;
	subtitle?: string;
	picture?: PictureRef;
	/** ISO time of the newest message. */
	lastAt?: string;
	attention?: boolean;
	/** The app computes this from the viewer's read cursor and replaces a host's own number. */
	unread?: number;
}

export type HostAction = HostActionView;
export type FormSpec = FormSpecView;
export type FormField = FormFieldView;
export type FormValues = Readonly<Record<string, string | readonly string[]>>;
export type ActionResult =
	| {
			ok: true;
			/** A short line shown to the person who acted. */
			notice?: string;
			/** Takes the person there after the action. */
			open?: OpenTarget;
			/** An external target, `https` or same-origin; `open` wins when both are given. */
			url?: string;
	  }
	| { ok: false; error: string; field?: string };

/**
 * Where a tap on a notice or a push goes, and where an action may take a person after it: a room,
 * scrolled to one message when `message` names it, or a page with its query.
 */
export type OpenTarget =
	| { room: ChannelKey; message?: number }
	| { page: string; query?: Readonly<Record<string, string>> };

export interface RoomHeader {
	title: string;
	fields: readonly { label: string; value: string; link?: string }[];
	actions: readonly HostAction[];
	banner?: { tone: "warn" | "risk"; text: string };
}

/**
 * A kind of room the host owns. Keys are `<surface>:<kind>.<id>`. Example: the kind "thread" of a
 * support inbox, one room per email thread. A kind is none of `agent`, `group`, `thread`, `home`,
 * and an id is `[A-Za-z0-9_-]{8,64}`.
 */
export interface HostRoomKind {
	kind: string;
	label: string;
	/** An icon of the console's own set, shown beside the kind's section; none = no icon. */
	icon?: HostIconName;
	/**
	 * The kind's own words for writing in its rooms. Where a viewer may send both a note and a turn,
	 * the room shows one toggle, "@AI" (off = a note for the room's people only, on =
	 * the agent answers): `turn.label` words the toggle, and each mode's `placeholder` is the box's
	 * hint while that mode is on. Without it the console's own words show.
	 */
	sendWording?: SendWording;
	/** Rooms this viewer may open. Undefined = the kind is not shown to them. */
	list(
		viewer: Viewer,
		query: { filter?: string; cursor?: string },
	): Promise<{ rooms: HostRoomSummary[]; cursor?: string } | undefined>;
	/** THE authority: asked again on every read, frame, send, card answer, upload and file. Undefined = 404. */
	access(viewer: Viewer, id: string): Promise<RoomAccess | undefined>;
	header?(viewer: Viewer, id: string): Promise<RoomHeader>;
	/** Called before a viewer's message is stored; may refuse. A "turn" is then delivered to the key's claim. */
	send?(
		viewer: Viewer,
		id: string,
		message: {
			mode: "note" | "turn";
			text: string;
			files: readonly RoomFileRef[];
		},
	): Promise<"accepted" | { refused: string }>;
	act?(
		viewer: Viewer,
		id: string,
		action: { action: string; card?: string },
		input: FormValues,
	): Promise<ActionResult>;
	/** The buttons of a HOST card this viewer may press; default all when `access.act`. Never applies to held-call or question cards. */
	buttons?(
		viewer: Viewer,
		id: string,
		card: StoredHostCard,
	): readonly string[] | Promise<readonly string[]>;
	/** How long the kind's messages, author names, host cards and files are kept. Unset = keep. */
	retention?: { textDays: number; fileDays: number };
}

/** A card a host puts in its room; its buttons call the host's `act`. */
export interface HostCard {
	title: string;
	body: string;
	tone?: "note" | "ok" | "warn" | "risk";
	state?: "open" | "working" | "done" | "superseded" | "expired";
	/** `https` or same-origin only. */
	links?: readonly { label: string; url: string }[];
	buttons?: readonly HostAction[];
	/**
	 * Keeps the card past its kind's `retention.textDays`, for as long as the host passes `true`: a
	 * ticket's pinned card while the ticket is open. The sweep skips it; `updateCard` without `keep`
	 * (or with `false`) makes it an ordinary card again, counted from when it was first posted.
	 */
	keep?: boolean;
}

/** A host card as it is stored. */
export interface StoredHostCard extends HostCard {
	id: string;
	room: ChannelKey;
	createdAt: Date;
	updatedAt: Date;
}

/** What a host does with its pages once they are registered. */
export interface HostPages {
	/**
	 * Tells the viewers a page is visible to (all pages when `id` is absent) that it may differ, so
	 * their page fetches `view()` again. The frame carries no content.
	 */
	changed(id?: string): void;
	/**
	 * Keeps an image for a page's Markdown, shown as `![alt](file:<id>)` and served only to those
	 * the page is visible to. PNG, JPEG or WebP; the bytes must be that image. Returns the file id.
	 */
	saveAsset(
		page: string,
		file: { name: string; type: string; bytes: Uint8Array | ReadableStream },
	): Promise<string>;
}

/** Writes into the host's rooms. Author kinds are generic; the host supplies the label ("Customer"). */
export interface HostRooms {
	post(
		room: ChannelKey,
		message: {
			author: {
				kind: HostAuthorKind;
				label?: string;
				name: string;
				/** The host vouches for it; the app does not check it against a session. */
				principalId?: string;
				picture?: PictureRef;
			};
			/** External and member: plain text with full-URL autolinks. Assistant and notice: Markdown, raw HTML as text. */
			text?: string;
			/** Ids from `saveFile`. */
			files?: readonly string[];
			/** The host's own id (an email Message-ID), unique per room. */
			reference?: string;
			/** For an import: history within retention. */
			at?: Date;
		},
	): Promise<{ id: number }>;
	edit(room: ChannelKey, id: number, text: string): Promise<void>;
	/** Deletes the row and its files now. */
	remove(room: ChannelKey, id: number): Promise<void>;
	byReference(room: ChannelKey, reference: string): Promise<number | undefined>;
	/**
	 * A room's recent messages as the block `CHANNEL_CONTEXT.read` gives a turn: what was said
	 * since the assistant last posted, at most `limit` (default 15, at most 100) newest messages,
	 * an outsider's words marked `external`, notices left out. For a host that starts a turn from
	 * a room's `send` hook and has no message that addressed the assistant. Unlike `read` it marks
	 * nothing handed over, so a retry gets the same; undefined when the room has nothing to give.
	 */
	context(
		room: ChannelKey,
		options?: { limit?: number; messageChars?: number },
	): Promise<ChannelContext | undefined>;
	card(room: ChannelKey, card: HostCard): Promise<{ id: string }>;
	updateCard(room: ChannelKey, id: string, card: HostCard): Promise<void>;
	saveFile(
		room: ChannelKey,
		file: { name: string; type: string; bytes: Uint8Array | ReadableStream },
	): Promise<string>;
	/**
	 * A same-origin URL that opens the room, scrolled to and highlighting `message` when given.
	 * Valid in a card's `links` and in assistant and notice Markdown.
	 */
	link(room: ChannelKey, message?: number): string;
	/** Tells the room's viewers its header or list may differ, and drops the access memo. */
	changed(room?: ChannelKey): void;
	/** Drops the access memo, for one person or for all; the next frame re-asks the kind. */
	accessChanged(principalId?: string): void;
}

// ── Pages that are not rooms ───────────────────────────────────────────────────────────────────

export type PageSection =
	| { kind: "markdown"; text: string }
	| {
			kind: "list";
			title?: string;
			rows: readonly {
				title: string;
				subtitle?: string;
				open?: string;
				attention?: boolean;
				actions?: readonly HostAction[];
			}[];
	  }
	| { kind: "form"; form: FormSpec; action: string }
	| { kind: "card"; card: HostCard };

/** A page that is not a room, at `<mount>/p/<id>`. Example: a support inbox's "Mailboxes" admin page. */
export interface HostPage {
	/** `[a-z0-9-]{1,40}`. */
	id: string;
	label: string;
	/** An icon of the console's own set, shown in the navigation; none = a list. */
	icon?: HostIconName;
	place: "main" | "settings" | "hidden";
	visible(viewer: Viewer): boolean | Promise<boolean>;
	view(
		viewer: Viewer,
		query: Readonly<Record<string, string>>,
	): Promise<{ title: string; sections: readonly PageSection[] }>;
	act?(
		viewer: Viewer,
		action: string,
		input: FormValues,
	): Promise<ActionResult>;
}

// ── Notices, onboarding, links ─────────────────────────────────────────────────────────────────

/** Person-addressed notices with state: the bell, the badge, push. */
export interface Notices {
	raise(notice: {
		/**
		 * The dedupe key: raising it again updates it and pushes again. It is also the push tag
		 * and the acknowledgement key, so the people the notice is for can see it: put no private
		 * id in it.
		 */
		tag: string;
		/** Principal ids. */
		to: readonly string[];
		title: string;
		body?: string;
		open?: OpenTarget;
		/** `high` requires interaction and ignores the person's quiet hours. */
		urgency: "normal" | "high";
		/** Shows "Handled", counted in the badge until acked or resolved. */
		ackable?: boolean;
		/** Default true. */
		push?: boolean;
		/**
		 * The transports that may carry this notice, in order; the sender tries only these. Absent =
		 * every transport the sender has registered, in order, until one says sent. A name no
		 * transport has is a ConfigError when the notice is raised.
		 */
		via?: readonly string[];
	}): Promise<void>;
	/** Pushes again, optionally to more people and through other transports (`via`, as in `raise`). */
	renotify(
		tag: string,
		add?: readonly string[],
		options?: { via?: readonly string[] },
	): Promise<void>;
	/** Clears the notice on every device. */
	resolve(
		tag: string,
		by?: { principalId?: string; reason: string },
	): Promise<void>;
	pending(tag: string): Promise<
		| {
				raisedAt: Date;
				to: readonly string[];
				acked: readonly { principalId: string; at: Date }[];
				received: readonly string[];
				opened: readonly string[];
		  }
		| undefined
	>;
	onAck(listener: (tag: string, principalId: string) => void): () => void;
}

/** An onboarding step. A step that is not required is a nudge: shown, never gating. */
export interface OnboardingStep {
	id: string;
	label: string;
	help?: string;
	required: boolean;
	applies?(viewer: Viewer): boolean | Promise<boolean>;
	done(viewer: Viewer): Promise<boolean>;
	/** The page where the person completes it. */
	open: { page: string };
	/** Required steps only; recorded with who and when. */
	waiver?: { label: string; confirm: string };
	/** Set by the app on the steps it makes itself; a host leaves it out. */
	builtin?: "link" | "push";
}

export interface StepStatus {
	id: string;
	label: string;
	help?: string;
	required: boolean;
	done: boolean;
	waived: boolean;
	open: { page: string };
	/** Present on a required step the person may waive. */
	waiver?: { label: string; confirm: string };
	/** Present on a step the app makes itself. */
	builtin?: "link" | "push";
}

/** Proves an account and links it. The app shows it; the host proves and writes. */
export interface LinkProver {
	/** An open string: "line", "discord", "github". */
	provider: string;
	label: string;
	/** Provers to complete first. */
	requires?: readonly string[];
	status(principalId: string): Promise<{
		linked?: { subject: string; displayName?: string; linkedAt: Date };
		pending?: {
			request: string;
			expiresAt: Date;
			redeemedBy?: { displayName: string; picture?: PictureRef };
		};
	}>;
	issue(principalId: string): Promise<{
		code: string;
		request: string;
		expiresAt: Date;
		instructions: string;
	}>;
	confirm(principalId: string, request: string): Promise<void>;
	cancel(principalId: string): Promise<void>;
	/** Must refuse config, cli and plugin links. */
	unlink(principalId: string): Promise<void>;
}

/** What the app of the web console offers a host plugin, registered from `setup`. */
export interface WebApp {
	/** The key prefix of the app's rooms: "app". */
	readonly surface: string;
	registerRoomKind(kind: HostRoomKind): void;
	registerPage(page: HostPage): void;
	registerStep(step: OnboardingStep): void;
	registerLinkProver(prover: LinkProver): void;
	readonly rooms: HostRooms;
	readonly pages: HostPages;
	readonly notices: Notices;
	readonly onboarding: {
		status(principalId: string): Promise<StepStatus[]>;
		changed(principalId: string): void;
	};
	readonly push: {
		status(
			principalId: string,
		): Promise<{ devices: number; lastReceiptAt?: Date; waived: boolean }>;
	};
}

/**
 * The web app's service. A host plugin registered after `web-console` lists it in `requires` and
 * registers its kinds, pages, steps and provers from `setup`; everything is checked when the web
 * service starts.
 */
export const WEB_APP: ServiceKey<WebApp> =
	serviceKey<WebApp>("roundtable.web.app");
