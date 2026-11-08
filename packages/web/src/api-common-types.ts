import type { PaneName } from "./panes.ts";

/** What an agent is doing in a room, while it works. */
export type ActivityPhase = "thinking" | "working";

/** A person's tier in the app, as `IDENTITY` gives it. */
export type AppTier = "owner" | "admin" | "member";

/** What the page needs before it can draw anything. */
export interface ConfigView {
	title: string;
	panes: PaneName[];
	/** The IANA zone the page formats times and event dates in: the host's `env.timeZone`. */
	timeZone: string;
	/** The page's look unless the owner picked one in the app; the server always sends it. */
	look?: "modern" | "camelot";
	/** The six `#rrggbb` skin tones every character is drawn with, which a look's `skin` index picks from: the host's `characters.skins`, the kit's own by default. */
	characterSkins?: readonly string[];
	locale?: string;
	messages?: Readonly<Record<string, string>>;
	cleanup?: boolean;
	connectorAdminUrl?: string;
	/** Which parts of the Connectors page the host serves; each is absent when it does not. */
	connectorParts?: { gateways?: true; manage?: true; grants?: true };
	/** Only supplied for path-based routing; also the base for page/API URLs. */
	mountPath?: string;
	/** Present when the `rooms` pane is served: how the page opens the owner app's socket. */
	app?: {
		/** The key prefix of the app's rooms, such as `app`. */
		surface: string;
		/** The WebSocket subprotocol to offer. */
		protocol: string;
		/** False when the host leaves the yolo and long-running switches out (`modes: false`). */
		modes?: false;
	};
	/** The visitor's tier. Sent only where the host admits more than its owners (`admission: "access"`). */
	tier?: AppTier;
	/** The steps still undone before the app opens; present only while the gate is closed. */
	gate?: GateStepView[];
	/** The host's pages that are not rooms, as far as this visitor may see them. */
	pages?: PageLinkView[];
	/** The kinds of host room this visitor may list. */
	kinds?: KindLinkView[];
	/** Web Push for this visitor's tier: who may subscribe, and (for an external sender) where. */
	push?: { tiers: AppTier[]; key?: string; subscribe?: string };
}

/** A step of onboarding the visitor still owes. */
export interface GateStepView {
	id: string;
	label: string;
	help?: string;
	/**
	 * Set on the steps the app makes itself, so the page words them in its own language: `link`
	 * for `link:<provider>` (with the account's label in `label`), `push` for the notifications step.
	 */
	builtin?: "link" | "push";
	/** A required step gates the app; a nudge is shown and never gates. */
	required: boolean;
	/** The page where the person completes it. */
	open: { page: string };
	/** The person may waive it; the label and the confirmation are what they are shown. */
	waiver?: { label: string; confirm: string };
}

/**
 * The icons a host may give a page or a kind of room: names from the console's own icon set. A
 * name outside the list, or none, shows the default (a list for a page, no icon for a kind).
 */
export const HOST_ICONS = [
	"chat",
	"link",
	"activity",
	"users",
	"megaphone",
	"qr",
	"settings",
	"bell",
	"file",
	"list",
	"shield",
	"lock",
	"sparkle",
] as const;

export type HostIconName = (typeof HOST_ICONS)[number];

/**
 * How a kind of host room words its two ways to write: `turn` is talking to the agent (the toggle's
 * label, and the box's hint while it is on), `note` is a message for the room's people only.
 */
export interface SendWording {
	note?: { placeholder?: string };
	turn?: { label?: string; placeholder?: string };
}

/** A host page that is not a room, in the places the shell lists it. */
export interface PageLinkView {
	id: string;
	label: string;
	place: "main" | "settings" | "hidden";
	icon?: HostIconName;
}

/** A kind of host room, listed by its label. */
export interface KindLinkView {
	kind: string;
	label: string;
	icon?: HostIconName;
}

/** Every error body the API returns. */
export interface ApiError {
	error: string;
}
