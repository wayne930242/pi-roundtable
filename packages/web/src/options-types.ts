import type {
	ChannelKey,
	ConversationRecord,
	RoundtablePlugin,
	Tier,
} from "pi-roundtable";
import type { PaneName } from "./api-types.ts";
import type { WorkspaceRoot } from "./app/workspace-files.ts";
import type { ConsoleFeatures, ConsolePresentation } from "./features.ts";
import type { QuietWindow } from "./push/quiet-hours.ts";
import type { RequestVerifier } from "./verifier.ts";
/**
 * The note pi-roundtable-mcp puts before a relayed message by default. A conversation opened over
 * remote MCP starts with it, so the console takes it off before showing the owner's words.
 */
export const DEFAULT_RELAY_NOTE =
	"(The owner wrote this in a personal agent that relays it over MCP, not on Discord. Answer the owner directly, just as you would on Discord; the agent passes your reply back.)";

/** The default environment variable `auth: { mode: "password" }` reads the password from. */
export const DEFAULT_PASSWORD_ENV = "ROUNDTABLE_WEB_PASSWORD";
/** How many days a password session lasts by default. */
export const DEFAULT_SESSION_DAYS = 30;
/** The shortest password the console accepts, in characters. */
export const MIN_PASSWORD_LENGTH = 12;
/** The key prefix of the app's rooms by default. */
export const DEFAULT_SURFACE = "app";
/** How many seconds a turn waits on its card before it goes on without the answer, by default. */
export const DEFAULT_CARD_GRACE_SECONDS = 120;

/**
 * How the console knows who is asking. Every mode but `verifier` speaks for one principal through
 * the plugin identity `token:web-console`, which the plugin declares; read "Authentication" and
 * "Threat model" in the README before choosing `none` or `password`.
 */
export type WebAuthOptions =
	| {
			/**
			 * No authentication: whoever reaches the listener is the owner. Written explicitly, never
			 * a default, and only for a listener a person cannot reach but the owner: a unix socket,
			 * or TCP on `127.0.0.1`, `::1` or `localhost`.
			 */
			mode: "none";
			/** Allows `none` on a TCP listener that reaches beyond this machine, when a network in front of it keeps everyone else out. */
			trustNetwork?: boolean;
			/** The principal it speaks for; default the primary owner (the first of `access.owners`). */
			principal?: string;
	  }
	| {
			/**
			 * A password from the environment, asked on a login page, then a signed session cookie.
			 * It resists the network, not an agent whose shell runs as the same user.
			 */
			mode: "password";
			/** The environment variable that holds the password, at least 12 characters; default `ROUNDTABLE_WEB_PASSWORD`. */
			passwordEnv?: string;
			/** How long a login lasts, 1 to 365 days; default 30. */
			sessionDays?: number;
			/** The principal it speaks for; default the primary owner. */
			principal?: string;
	  }
	| {
			/** A request verifier, such as `cloudflareAccess(...)`; the same as the `verifier` option. */
			mode: "verifier";
			verifier: RequestVerifier;
	  }
	| OidcOptions;

/**
 * Sign-in with an OpenID Connect provider (authorization code with PKCE). The id_token is checked
 * once, at the callback; the app then keeps its own server-side session, which slides: it ends
 * after `sessionDays` without a visit. Who the person is, and the tier they hold, come from
 * `IDENTITY` for every request. The origin must be https.
 */
export interface OidcOptions {
	mode: "oidc";
	/** The exact `iss` of the id_token. */
	issuer: string;
	/** Default `${issuer}/.well-known/openid-configuration`; read at start, which fails if it cannot be. */
	discoveryUrl?: string;
	clientId: string;
	/** The environment variable that holds the client secret; set = a confidential client, left out = a public client with PKCE. */
	clientSecretEnv?: string;
	/** Default `openid`, `profile`. `offline_access` is refused: the app keeps no refresh token. */
	scopes?: readonly string[];
	/** The claim that names the person; default `sub` (Entra: `oid`). */
	subjectClaim?: string;
	/** The claim for their name; default `name`, then `preferred_username`, then the subject. */
	nameClaim?: string;
	/** The claim that carries app roles, each becoming `<surface>:role:<name>`; default `roles`; `false` reads none. */
	rolesClaim?: string | false;
	/** Decides at sign-in whether this token is acceptable at all. */
	check?: (claims: Readonly<Record<string, unknown>>) => boolean;
	/** How many days without a visit end a session, 1 to 365; default 30. */
	sessionDays?: number;
	/** Whether logging out also signs out at the provider (without `id_token_hint`); default false. */
	endSession?: boolean;
	/**
	 * Asks the provider again after this many hours: the next page load goes through a silent
	 * `prompt=none` round trip, which refreshes the stored facts and roles; when the provider wants
	 * the person, they sign in as usual. Until then an API or socket request of that session is
	 * answered 401. Default: never.
	 */
	reauthHours?: number;
	/** The id_token claims to keep with the session (replaced at each sign-in and re-verify, never logged); default none. */
	storeClaims?: readonly string[];
	/**
	 * Called with the person's principal id when a request or an open socket proves they hold a
	 * live session, at most once per session every five minutes. For a host that counts who is
	 * present, such as one that keeps a linked chat account only while its web person is active: a
	 * person who only has the app open, calling nothing of the host's, still counts. It is not
	 * awaited, and an error it throws is logged and never fails the request.
	 */
	onSessionVerified?: (principalId: string) => void | Promise<void>;
}

/** `auth` checked and filled in. */
export type ResolvedAuth =
	| { mode: "none"; trustNetwork: boolean; principal?: string }
	| {
			mode: "password";
			passwordEnv: string;
			sessionDays: number;
			principal?: string;
	  }
	| { mode: "verifier"; verifier: RequestVerifier }
	| ResolvedOidc;

export interface ResolvedOidc {
	mode: "oidc";
	issuer: string;
	discoveryUrl: string;
	clientId: string;
	clientSecretEnv: string | undefined;
	scopes: readonly string[];
	subjectClaim: string;
	nameClaim: string | undefined;
	rolesClaim: string | false;
	check: ((claims: Readonly<Record<string, unknown>>) => boolean) | undefined;
	sessionDays: number;
	endSession: boolean;
	reauthHours: number | undefined;
	storeClaims: readonly string[];
	onSessionVerified:
		| ((principalId: string) => void | Promise<void>)
		| undefined;
}

/** The panes each tier is served, when the list differs by tier. */
export interface TierPanes {
	owner: readonly PaneName[];
	/** Default: the member's list. */
	admin?: readonly PaneName[];
	member: readonly PaneName[];
}

export interface WebConsoleOptions {
	/**
	 * How requests are authenticated; one of `auth` or `verifier` is required, and without either
	 * the plugin refuses to start rather than serve without authentication. Only a person whose
	 * principal holds the owner role gets in.
	 */
	auth?: WebAuthOptions;
	/**
	 * Decides whether a request comes from someone the operator's proxy authenticated, and reports
	 * who; the same as `auth: { mode: "verifier", verifier }`, and giving both throws.
	 * `cloudflareAccess(...)` is the built-in one.
	 */
	verifier?: RequestVerifier;
	/** Host-specific data and actions, resolved against public plugin setup context. */
	features?:
		| ConsoleFeatures
		| ((
				context: Parameters<RoundtablePlugin["setup"]>[0],
		  ) => ConsoleFeatures | Promise<ConsoleFeatures>);
	/** Localized labels and error text; English source strings are dictionary keys. */
	presentation?: ConsolePresentation;
	/**
	 * The console's own origin, such as `https://console.example.com`: requests that change data
	 * must carry it as their `Origin`, and the dashboard line links to it.
	 */
	origin: string;
	/**
	 * The origin an incoming webhook's URL starts with, such as `https://hooks.example.com`, when the
	 * public hook hostname is not the console's; default `origin`. The path is the console's mount.
	 */
	webhookOrigin?: string;
	/**
	 * Deprecated: the owner's principal that a verifier reporting no actor speaks for; default the
	 * primary owner (the first of `access.owners`). The notes pane shows each visitor their own
	 * notes, and any principal's on request.
	 */
	ownerId?: string;
	/** The host's data directory, whose `sessions/` holds the conversations; default `./data`. */
	dataDir?: string;
	/** The path the console is served under; default `/console`. */
	mountPath?: string;
	/** The listener whose address serves it; default `public`. */
	listener?: string;
	/** Hash routes by default; path routes retain links such as /console/skills. */
	routing?: "hash" | "path";
	/**
	 * Who the app admits: `owners` (default, as before 0.26) lets in only people who hold the owner
	 * role; `access` lets in everyone `IDENTITY` admits on the app's surface, owners, admins and
	 * members, and provisions a new principal at a first contact where `access.provisioning` says so
	 * for the surface. `access` needs a credential that names a person (`oidc`, or a verifier that
	 * reports an actor), not `none` or `password`.
	 */
	admission?: "owners" | "access";
	/**
	 * The panes to serve, in the order the page lists them; default `rooms`, `table`, `workspace`,
	 * `overview`, `schedules`, `conversations`, `notes`. `rooms` is the owner app: the same agent
	 * team as on Discord, in rooms of its own; `table` seats its agents at the round table and
	 * needs `rooms`; `workspace` browses and edits the agents' files and needs `rooms` and a
	 * directory to show (the agents' own, or `workspace.roots`). The default list leaves
	 * `workspace` out when there is no directory; an explicit list that names it must have one.
	 * An explicit list is kept as written, so a host that listed the panes before 0.23 adds
	 * `rooms`, `table` and `schedules` by hand, and one that listed them before 0.24 adds
	 * `workspace`. With `admission: "access"` the default also has `profile`, and a member is
	 * served `rooms` (the host's rooms only), `conversations`, `notes`, `schedules` and `profile`
	 * of those the owners have; give `{ owner, admin?, member }` to choose per tier. A member is
	 * never served `overview`, `table`, `workspace`, `skills` or `connectors`, and naming one for
	 * them is an error. `notes` in the default list is dropped, with a warning, when the host keeps
	 * no memory; naming it with no memory is an error.
	 */
	panes?: readonly PaneName[] | TierPanes;
	/**
	 * What the `workspace` pane shows. The agents' working directory (`agents`) and their scratch
	 * directory (`scratch`, when the host has one) are shown without being named, from
	 * `AGENTS.workspace`; `roots` adds more, or `agents: false` / `scratch: false` leaves one out.
	 * A root must not be, or contain, the host's `dataDir`, which holds the sessions and keys.
	 */
	workspace?: {
		/** More directories to show: an `id` (a lower-case word), a `label`, an absolute `dir`, and whether the owner may change files in it (default false). */
		roots?: readonly {
			id: string;
			label: string;
			dir: string;
			writable?: boolean;
		}[];
		/** Leave the agents' working directory out of the pane; default shown. */
		agents?: boolean;
		/** Leave the agents' scratch directory out of the pane; default shown when the host has one. */
		scratch?: boolean;
	};
	/**
	 * The key prefix of the app's rooms: `<surface>:agent.<name>` and `<surface>:group.<name>`.
	 * A lower-case word that is not `discord`; default `app`. Rooms keep their conversations under
	 * it, so changing it starts every room over.
	 */
	surface?: string;
	/**
	 * How long a turn waits on its approval or question card before it goes on without the answer,
	 * in seconds; default 120, as on Discord. The card stays open for a day, and an answer given
	 * then starts a new turn in the room.
	 */
	cardGraceSeconds?: number;
	/**
	 * The most bytes of one file a person may upload in the app, 100 MiB by default. The upload
	 * route raises the listener's request body limit to this plus the form's framing, and the
	 * agent reads files up to it. At most 4 GiB. The listener has one body limit, so this raises
	 * it for every route on the listener, not only the upload route. A reverse proxy in front has a limit of its own, and
	 * Cloudflare's free plan caps request bodies at 100 MB. Files are streamed to disk, not held
	 * in memory.
	 */
	uploadMaxBytes?: number;
	/**
	 * Web Push to the owner's devices, sent when a card waits, a long-running cap is reached, an
	 * agent replies on its own, or a notice is sent, and no page of the owner is in view. The
	 * payload is encrypted for the device. Only the `rooms` pane has push.
	 */
	push?: {
		/**
		 * Whether a notification shows the start of the message (the first 120 characters); default
		 * true. With `false` it says only that something is waiting and where.
		 */
		preview?: boolean;
		/**
		 * The hours when an agent's post and a notice are not pushed, as `HH:MM` times on the
		 * console's time zone (`timeZone` of the host); a window that ends before it starts crosses
		 * midnight. A card (one waiting, or the long-running cap) is pushed all the same. Default
		 * 23:00 to 08:00; `false` pushes at any hour. The two times must differ.
		 */
		quietHours?: QuietWindow | false;
		/**
		 * Push services the server may post to besides the browsers' own (Google, Mozilla, Apple,
		 * Microsoft), as host names; a leading `*.` allows every subdomain. Their endpoints must
		 * still be `https`.
		 */
		endpointHosts?: readonly string[];
		/**
		 * Who a push service may contact about this server (the VAPID `sub`): a `mailto:` or
		 * `https:` URL. Default `origin` when that is `https`; with an `http` origin push stays off
		 * until this is set.
		 */
		subject?: string;
		/** The tiers whose people may subscribe and receive push; default `["owner"]`. */
		tiers?: readonly Tier[];
		/**
		 * Where a push is signed and sent: `internal` (default), by this process with its own VAPID
		 * key; or `external`, by a sender process the operator runs with the key, so this process
		 * never holds it. `publicKey` is the key browsers subscribe against; `subscribePath` is where
		 * the sender serves the subscription routes, when it does.
		 */
		sender?:
			| "internal"
			| { external: { publicKey: string; subscribePath?: string } };
		/**
		 * What leaves the app for a push: `full` (a title and a preview) or `none` (the kind, a tag and
		 * a count only). Default `full` for an internal sender and `none` for an external one. A host
		 * room never previews.
		 */
		content?: "full" | "none";
		/**
		 * The names of the transports besides `web-push` that the sender carries, such as `slack`. A
		 * notice's `via` may name only these and `web-push`; naming any other is a ConfigError when
		 * the notice is raised. The app never loads a transport: the sender process does.
		 */
		transports?: readonly string[];
	};
	/**
	 * What a person owes before the app opens. `links` names providers whose accounts they must
	 * link (`required` gates the app, `nudge` only asks); each needs a `LinkProver` registered
	 * through `WEB_APP`. `push` asks them to turn push on and receive a test; `pushWaiver` lets
	 * them waive a required push step.
	 */
	onboarding?: {
		links?: Readonly<Record<string, "required" | "nudge">>;
		push?: "required" | "nudge" | "off";
		pushWaiver?: boolean;
	};
	/** Leave out the yolo and long-running switches: no mode is shown or set, and `PUT api/rooms/<key>/mode` answers 404. */
	modes?: false;
	/** The files of the app's agent rooms; `keepDays` is how long stored files are kept, default 30. */
	uploads?: { keepDays?: number };
	/** The page's title and heading; default `Roundtable`. */
	title?: string;
	/** The page's `description` and `og:description` for search and link previews; default from the title. */
	description?: string;
	/** Where the install icons come from; default the ones this package ships. */
	icons?: { dir: string };
	/**
	 * How the page looks: `look` is `modern` (default) or `camelot`, and the page's owner can switch it
	 * in the app. `home` is what the app opens on: `rooms` (default) the arranged room list, or
	 * `chats` the chat list: pinned rooms as big avatars, one list by latest activity, folders as
	 * chips, hidden and archived rooms behind one row, and everything else behind a grid button.
	 */
	appearance?: { look?: "modern" | "camelot"; home?: "rooms" | "chats" };
	/** Text a relayed message begins with, taken off the owner's words; default the remote MCP note. */
	relayNotes?: readonly string[];
	/**
	 * Conversations the console neither lists nor reads. `record` is what the host's registry
	 * holds of the conversation, if anything, so a host can decide by its kind or owner.
	 */
	exclude?: (key: ChannelKey, record?: ConversationRecord) => boolean;
	/** The built page's directory; default the `dist/` this package ships. Set it only in tests. */
	assetDir?: string;
}

/** Options checked and filled in. */
export interface ResolvedOptions {
	auth: ResolvedAuth;
	origin: string;
	webhookOrigin: string;
	ownerId: string | undefined;
	dataDir: string;
	sessionsDir: string;
	mount: string;
	listener: string;
	routing: "hash" | "path";
	admission: "owners" | "access";
	/** The owners' panes: what `panes` named, or the default. */
	panes: PaneName[];
	/** The panes each tier is served. Admins and members are served none unless `admission` is `access`. */
	tierPanes: Readonly<Record<Tier, readonly PaneName[]>>;
	/** Whether `panes` was written out, which makes a missing directory for the workspace pane an error. */
	panesGiven: boolean;
	/** The `workspace` option checked and filled in. */
	workspace: {
		roots: readonly WorkspaceRoot[];
		agents: boolean;
		scratch: boolean;
	};
	surface: string;
	cardGraceSeconds: number;
	uploadMaxBytes: number;
	push: {
		preview: boolean;
		/** The quiet hours; undefined = none. */
		quietHours: QuietWindow | undefined;
		endpointHosts: readonly string[];
		/** The VAPID contact; undefined = push is off. */
		subject: string | undefined;
		fetch: typeof fetch | undefined;
		tiers: readonly Tier[];
		sender:
			| "internal"
			| { external: { publicKey: string; subscribePath?: string } };
		content: "full" | "none";
		/** `web-push` and the host's own transports. */
		transports: readonly string[];
	};
	onboarding: {
		links: Readonly<Record<string, "required" | "nudge">>;
		push: "required" | "nudge" | "off";
		pushWaiver: boolean;
	};
	/** Whether the yolo and long-running switches are served. */
	modes: boolean;
	uploadKeepDays: number;
	title: string;
	description: string | undefined;
	iconsDir: string | undefined;
	look: "modern" | "camelot";
	home: "rooms" | "chats";
	relayNotes: readonly string[];
	exclude:
		| ((key: ChannelKey, record?: ConversationRecord) => boolean)
		| undefined;
	assetDir: string | undefined;
	features: WebConsoleOptions["features"];
	presentation: ConsolePresentation | undefined;
}
