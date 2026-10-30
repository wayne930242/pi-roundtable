import type { ChannelKey, ServiceKey, Tier } from "pi-roundtable";
import { PluginError, serviceKey } from "pi-roundtable";
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
		/** The dedupe key: raising it again updates it and pushes again. */
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

// ── Where the pieces of the app plug in ────────────────────────────────────────────────────────

/** A kind's id and a page's id as they appear in keys and routes. */
const KIND_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const PAGE_ID = /^[a-z0-9-]{1,40}$/;
const RESERVED_KINDS: ReadonlySet<string> = new Set([
	"agent",
	"group",
	"thread",
	"home",
]);

/** The services the pieces of the app provide once built; the registry hands them to the host. */
export interface WebAppParts {
	rooms: HostRooms;
	pages: HostPages;
	notices: Notices;
	onboarding: WebApp["onboarding"];
	push: WebApp["push"];
}

/** Whether a person waived a required step; the onboarding service supplies it. */
export interface WaiverRead {
	waived(principalId: string, step: string): Promise<boolean>;
}

/** What a socket frame handler of a plugged-in piece is given. */
export interface FrameContext<F> {
	frame: F;
	viewer: Viewer;
	/** The connection the frame came on, for what is per socket: the subscriptions, the focus. */
	connection: import("./app/sockets.ts").AppSocket;
	/** Answers a frame that cannot be taken. `id` echoes the frame's own reference. */
	refuse(code: import("./api-types.ts").RefusalCode, id?: string): void;
}

export type FrameHandler<F> = (context: FrameContext<F>) => Promise<void>;

/** The frames the pieces of the app handle: host rooms (D) and notices (E). */
export type PluggedFrames = {
	[K in import("./api-types.ts").ClientFrame["type"] &
		("subscribe" | "unsubscribe" | "act" | "ack" | "read")]: Extract<
		import("./api-types.ts").ClientFrame,
		{ type: K }
	>;
} & {
	/** A `send` or `stop` into a host room; an agent room's goes the app's own way. */
	hostSend: Extract<import("./api-types.ts").ClientFrame, { type: "send" }>;
	hostStop: Extract<import("./api-types.ts").ClientFrame, { type: "stop" }>;
};

/**
 * What decides who reads a host room right now. The delivery of room frames asks `readNow` for
 * every frame and every connection, so it answers from a memo; `read` asks the kind itself.
 */
export interface HostRoomAccess {
	read(viewer: Viewer, room: ChannelKey): Promise<boolean>;
	readNow(
		connection: import("./app/sockets.ts").AppSocket,
		room: string,
	): boolean;
}

/** A REST area the pieces of the app answer, below `<mount>/api/`. */
export interface RouteArea {
	/** The first segment after `api/`, such as `host`. */
	area: string;
	handle(
		request: Request,
		parts: readonly string[],
		context: { visitor: Visitor; viewer: Viewer },
	): Promise<Response>;
}

const unbound = (what: string): never => {
	throw new PluginError(
		`web app: ${what} is not available yet. It is provided when the web service starts; use it from a callback or after start`,
	);
};

/**
 * The registries behind `WEB_APP`: what hosts register in `setup`, validated when the web service
 * starts, and the places where the other pieces of the app plug in: socket frame handlers, REST
 * areas, the room-access rule, and the services (`rooms`, `notices`, `onboarding`, `push`) a host
 * reaches through the `WebApp`.
 */
export class WebAppRegistry implements WebApp {
	readonly surface: string;
	readonly #kinds = new Map<string, HostRoomKind>();
	readonly #pages = new Map<string, HostPage>();
	readonly #steps = new Map<string, OnboardingStep>();
	readonly #provers = new Map<string, LinkProver>();
	readonly #frames = new Map<string, FrameHandler<never>>();
	readonly #areas = new Map<string, RouteArea>();
	readonly #listeners = new Set<() => void>();
	#parts: Partial<WebAppParts> = {};
	#waivers: WaiverRead | undefined;
	#access: HostRoomAccess | undefined;
	#started = false;

	constructor(surface: string) {
		this.surface = surface;
	}

	// ── What a host registers ──

	registerRoomKind(kind: HostRoomKind): void {
		this.#open("registerRoomKind");
		if (!KIND_NAME.test(kind.kind) || RESERVED_KINDS.has(kind.kind))
			throw new PluginError(
				`web app: room kind ${JSON.stringify(kind.kind)} must be a lower-case word and not agent, group, thread or home`,
			);
		if (this.#kinds.has(kind.kind))
			throw new PluginError(
				`web app: room kind ${kind.kind} is registered twice`,
			);
		this.#kinds.set(kind.kind, kind);
		this.#changed();
	}

	registerPage(page: HostPage): void {
		this.#open("registerPage");
		if (!PAGE_ID.test(page.id))
			throw new PluginError(
				`web app: page id ${JSON.stringify(page.id)} must match [a-z0-9-]{1,40}`,
			);
		if (this.#pages.has(page.id))
			throw new PluginError(`web app: page ${page.id} is registered twice`);
		this.#pages.set(page.id, page);
		this.#changed();
	}

	registerStep(step: OnboardingStep): void {
		this.#open("registerStep");
		if (this.#steps.has(step.id))
			throw new PluginError(`web app: step ${step.id} is registered twice`);
		this.#steps.set(step.id, step);
		this.#changed();
	}

	registerLinkProver(prover: LinkProver): void {
		this.#open("registerLinkProver");
		if (this.#provers.has(prover.provider))
			throw new PluginError(
				`web app: a link prover for ${prover.provider} is registered twice`,
			);
		this.#provers.set(prover.provider, prover);
		this.#changed();
	}

	#open(what: string): void {
		if (this.#started)
			throw new PluginError(
				`web app: ${what} was called after the web service started; register from setup`,
			);
	}

	#changed(): void {
		for (const listener of this.#listeners) listener();
	}

	// ── What a host reaches ──

	get rooms(): HostRooms {
		return this.#parts.rooms ?? unbound("rooms");
	}
	get pages(): HostPages {
		return this.#parts.pages ?? unbound("pages");
	}
	get notices(): Notices {
		return this.#parts.notices ?? unbound("notices");
	}
	get onboarding(): WebApp["onboarding"] {
		return this.#parts.onboarding ?? unbound("onboarding");
	}
	get push(): WebApp["push"] {
		return this.#parts.push ?? unbound("push");
	}

	// ── What the pieces of the app read and plug in ──

	kinds(): readonly HostRoomKind[] {
		return [...this.#kinds.values()];
	}
	kind(name: string): HostRoomKind | undefined {
		return this.#kinds.get(name);
	}
	hostPages(): readonly HostPage[] {
		return [...this.#pages.values()];
	}
	page(id: string): HostPage | undefined {
		return this.#pages.get(id);
	}
	steps(): readonly OnboardingStep[] {
		return [...this.#steps.values()];
	}
	step(id: string): OnboardingStep | undefined {
		return this.#steps.get(id);
	}
	provers(): readonly LinkProver[] {
		return [...this.#provers.values()];
	}
	prover(provider: string): LinkProver | undefined {
		return this.#provers.get(provider);
	}

	/** Hears of a registration, so a gate or a list built from them can be rebuilt. */
	onRegister(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** The services the pieces of the app provide; each of `rooms`, `notices`, `onboarding` and `push` once. */
	provide(parts: Partial<WebAppParts>): void {
		for (const name of Object.keys(parts) as (keyof WebAppParts)[])
			if (this.#parts[name])
				throw new PluginError(`web app: ${name} is provided twice`);
		this.#parts = { ...this.#parts, ...parts };
	}

	/** Where the person's waivers are read from. */
	setWaivers(waivers: WaiverRead): void {
		this.#waivers = waivers;
	}
	waived(principalId: string, step: string): Promise<boolean> {
		return this.#waivers?.waived(principalId, step) ?? Promise.resolve(false);
	}

	/** Replaces the deny-all room-access rule. */
	setAccess(access: HostRoomAccess): void {
		this.#access = access;
	}
	get access(): HostRoomAccess {
		return this.#access ?? DENY_ACCESS;
	}

	/** Registers the handler of a frame the pieces of the app take. One handler per frame. */
	onFrame<K extends keyof PluggedFrames>(
		type: K,
		handler: FrameHandler<PluggedFrames[K]>,
	): void {
		if (this.#frames.has(type))
			throw new PluginError(`web app: the ${type} frame has two handlers`);
		this.#frames.set(type, handler as FrameHandler<never>);
	}
	frameHandler<K extends keyof PluggedFrames>(
		type: K,
	): FrameHandler<PluggedFrames[K]> | undefined {
		return this.#frames.get(type) as FrameHandler<PluggedFrames[K]> | undefined;
	}

	/** Registers the REST area the pieces of the app answer. */
	onArea(area: RouteArea): void {
		if (this.#areas.has(area.area))
			throw new PluginError(`web app: api/${area.area} has two handlers`);
		this.#areas.set(area.area, area);
	}
	areaFor(name: string): RouteArea | undefined {
		return this.#areas.get(name);
	}

	/** Whether the key is a room of a host kind: `<surface>:<kind>.<id>` with a registered kind. */
	isHostRoom(key: string): boolean {
		return this.hostKindOf(key) !== undefined;
	}
	/** The registered kind and id a host room key names. */
	hostKindOf(key: string): { kind: HostRoomKind; id: string } | undefined {
		const prefix = `${this.surface}:`;
		if (!key.startsWith(prefix)) return undefined;
		const rest = key.slice(prefix.length);
		const dot = rest.indexOf(".");
		if (dot <= 0) return undefined;
		const kind = this.#kinds.get(rest.slice(0, dot));
		return kind ? { kind, id: rest.slice(dot + 1) } : undefined;
	}

	/** Closes registration; the web service calls it at start, after checking what was registered. */
	seal(): void {
		this.#started = true;
	}
}

const DENY_ACCESS: HostRoomAccess = {
	read: async () => false,
	readNow: () => false,
};
