import { join, resolve } from "node:path";
import type {
	ChannelKey,
	ConversationRecord,
	RoundtablePlugin,
	Tier,
} from "pi-roundtable";
import { PluginError, TIERS } from "pi-roundtable";
import { OWNER_ONLY_PANES, PANES, type PaneName } from "./api-types.ts";
import {
	DEFAULT_UPLOAD_MAX_BYTES,
	UPLOAD_FRAMING_BYTES,
} from "./app/uploads.ts";
import { checkRoots, type WorkspaceRoot } from "./app/workspace-files.ts";
import type { ConsoleFeatures, ConsolePresentation } from "./features.ts";
import { isHostPattern } from "./push/endpoint.ts";
import {
	DEFAULT_QUIET_HOURS,
	minutesOfDay,
	type QuietWindow,
} from "./push/quiet-hours.ts";
import { pushFetchOf } from "./push/test-fetch.ts";
import type { RequestVerifier } from "./verifier.ts";

/**
 * The note pi-roundtable-mcp puts before a relayed message by default. A conversation opened over
 * remote MCP starts with it, so the console takes it off before showing the owner's words.
 */
export const DEFAULT_RELAY_NOTE =
	"(The owner wrote this in a personal agent that relays it over MCP, not on Discord. Answer the owner directly, just as you would on Discord; the agent passes your reply back.)";

/** The default environment variable `auth: { mode: "password" }` reads the password from. */
const DEFAULT_PASSWORD_ENV = "ROUNDTABLE_WEB_PASSWORD";
/** How many days a password session lasts by default. */
const DEFAULT_SESSION_DAYS = 30;
/** The shortest password the console accepts, in characters. */
export const MIN_PASSWORD_LENGTH = 12;
/** The key prefix of the app's rooms by default. */
const DEFAULT_SURFACE = "app";
/** How many seconds a turn waits on its card before it goes on without the answer, by default. */
const DEFAULT_CARD_GRACE_SECONDS = 120;

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
	/**
	 * The page's description for search results and link previews (`description` and
	 * `og:description`); default a line derived from the title.
	 */
	description?: string;
	/** Where the install icons come from; default the ones this package ships. */
	icons?: { dir: string };
	/** How the page looks: `modern` (default) or `camelot`. The page's owner can switch it in the app. */
	appearance?: { look?: "modern" | "camelot" };
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
	relayNotes: readonly string[];
	exclude:
		| ((key: ChannelKey, record?: ConversationRecord) => boolean)
		| undefined;
	assetDir: string | undefined;
	features: WebConsoleOptions["features"];
	presentation: ConsolePresentation | undefined;
}

const SEGMENT = /^[A-Za-z0-9._~-]+$/;

function fail(message: string): never {
	throw new PluginError(`pi-roundtable-web: ${message}`);
}

function checkMount(path: string): string {
	const mount = path.replace(/\/+$/, "");
	const segments = mount.split("/").slice(1);
	if (
		!mount.startsWith("/") ||
		segments.length === 0 ||
		!segments.every(
			(segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..",
		)
	)
		fail(
			`mountPath ${JSON.stringify(path)} must be a path of at least one segment, such as /console`,
		);
	return mount;
}

function checkOrigin(origin: string): string {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		fail(
			`origin ${JSON.stringify(origin)} is not a URL such as https://console.example.com`,
		);
	}
	if (
		(url.protocol !== "https:" && url.protocol !== "http:") ||
		url.origin !== origin.replace(/\/+$/, "")
	)
		fail(
			`origin ${JSON.stringify(origin)} must be only a scheme and host, such as https://console.example.com`,
		);
	return url.origin;
}

const DEFAULT_OWNER_PANES: readonly PaneName[] = [
	"rooms",
	"table",
	"workspace",
	"overview",
	"schedules",
	"conversations",
	"notes",
];

/** The panes a member is served by default, of those the owners have. */
const DEFAULT_MEMBER_PANES: readonly PaneName[] = [
	"rooms",
	"conversations",
	"notes",
	"schedules",
	"profile",
];

function checkPaneList(panes: readonly PaneName[], label: string): PaneName[] {
	if (!Array.isArray(panes)) fail(`${label} must be a list of panes`);
	if (panes.length === 0) fail(`${label} is empty; serve at least one pane`);
	for (const pane of panes)
		if (!PANES.includes(pane))
			fail(
				`unknown pane ${JSON.stringify(pane)} in ${label}; the panes are ${PANES.join(", ")}`,
			);
	if (new Set(panes).size !== panes.length) fail(`${label} lists a pane twice`);
	return [...panes];
}

/** The panes of the owners, as before: what the other panes need of them is checked here. */
function checkOwnerPanes(panes: readonly PaneName[]): PaneName[] {
	const list = checkPaneList(panes, "panes");
	if (list.includes("schedules") && !list.includes("rooms"))
		fail("the schedules pane needs the rooms pane, which serves its API");
	if (list.includes("table") && !list.includes("rooms"))
		fail("the table pane needs the rooms pane, whose agents it seats");
	if (list.includes("workspace") && !list.includes("rooms"))
		fail("the workspace pane needs the rooms pane, which serves its API");
	return list;
}

interface CheckedPanes {
	owner: PaneName[];
	admin: PaneName[];
	member: PaneName[];
	given: boolean;
}

function checkPanes(
	panes: WebConsoleOptions["panes"],
	admission: "owners" | "access",
): CheckedPanes {
	const tiered =
		panes !== undefined && !Array.isArray(panes)
			? (panes as TierPanes)
			: undefined;
	if (tiered && (typeof tiered !== "object" || tiered === null))
		fail("panes must be a list, or { owner, admin?, member }");
	const owner = checkOwnerPanes(
		tiered
			? tiered.owner
			: ((panes as readonly PaneName[] | undefined) ?? [
					...DEFAULT_OWNER_PANES,
					...(admission === "access" ? (["profile"] as const) : []),
				]),
	);
	if (!tiered || admission !== "access") {
		if (tiered && admission === "owners")
			fail(
				'panes names panes per tier, but only admission "access" admits anyone but owners',
			);
		const member =
			admission === "access"
				? DEFAULT_MEMBER_PANES.filter((pane) => owner.includes(pane))
				: [];
		return { owner, admin: member, member, given: panes !== undefined };
	}
	const member = checkPaneList(tiered.member, "panes.member");
	const admin = tiered.admin
		? checkPaneList(tiered.admin, "panes.admin")
		: [...member];
	for (const [label, list] of [
		["panes.member", member],
		["panes.admin", admin],
	] as const) {
		for (const pane of list) {
			if ((OWNER_ONLY_PANES as readonly string[]).includes(pane))
				fail(
					`${label} names the ${pane} pane, which only owners are served: it shows the whole host`,
				);
			if (!owner.includes(pane))
				fail(
					`${label} names the ${pane} pane, which the owners' panes do not have; the pane's API is served for the owners' list`,
				);
		}
	}
	return { owner, admin, member, given: true };
}

/**
 * What no place of the files pane may be or contain: the host's data directory, and Pi's agent
 * directory in its default place beside the sessions (`auth.json` lives there).
 */
export function protectedDirs(dataDir: string): string[] {
	return [resolve(dataDir), resolve(dataDir, "pi")];
}

function checkWorkspace(
	options: WebConsoleOptions,
	dataDir: string,
): ResolvedOptions["workspace"] {
	const given = options.workspace;
	if (given === undefined) return { roots: [], agents: true, scratch: true };
	if (typeof given !== "object" || given === null)
		return fail("workspace must be an object such as { roots: [...] }");
	for (const key of ["agents", "scratch"] as const)
		if (given[key] !== undefined && typeof given[key] !== "boolean")
			fail(`workspace.${key} must be true or false`);
	const list = given.roots ?? [];
	if (!Array.isArray(list)) fail("workspace.roots must be a list");
	const roots: WorkspaceRoot[] = list.map((root, index) => {
		if (
			typeof root !== "object" ||
			root === null ||
			typeof root.id !== "string" ||
			typeof root.label !== "string" ||
			!root.label.trim() ||
			typeof root.dir !== "string" ||
			(root.writable !== undefined && typeof root.writable !== "boolean")
		)
			return fail(
				`workspace.roots[${index}] must be { id, label, dir, writable? } with text for the first three`,
			);
		return {
			id: root.id,
			label: root.label.trim(),
			dir: root.dir,
			writable: root.writable === true,
		};
	});
	for (const reserved of ["agents", "scratch"])
		if (roots.some((root) => root.id === reserved))
			fail(
				`workspace.roots may not use the id ${reserved}, which names the agents' own directory`,
			);
	checkRoots(roots, protectedDirs(dataDir));
	return {
		roots,
		agents: given.agents !== false,
		scratch: given.scratch !== false,
	};
}

function checkAuth(options: WebConsoleOptions): ResolvedAuth {
	const { auth, verifier } = options;
	if (auth !== undefined && verifier !== undefined)
		fail(
			'both auth and verifier are given. `verifier` is shorthand for `auth: { mode: "verifier", verifier }`; pass one',
		);
	if (auth === undefined) {
		if (typeof verifier !== "function")
			fail(
				'no verifier or auth. The console serves the owner\'s conversations and notes, so it will not start without a way to authenticate every request; pass `auth: { mode: "password" }`, `auth: { mode: "none" }` for a listener only the owner reaches, or `verifier: cloudflareAccess({...})` or your own',
			);
		return { mode: "verifier", verifier };
	}
	const mode = (auth as { mode?: unknown } | null)?.mode;
	const principal = (auth as { principal?: unknown }).principal;
	if (
		principal !== undefined &&
		(typeof principal !== "string" || !principal.trim())
	)
		fail(
			"auth.principal is empty. Leave it out to speak for the primary owner",
		);
	const named =
		typeof principal === "string" ? { principal: principal.trim() } : {};
	switch (mode) {
		case "none": {
			const { trustNetwork } = auth as { trustNetwork?: unknown };
			if (trustNetwork !== undefined && typeof trustNetwork !== "boolean")
				fail("auth.trustNetwork must be true or false");
			return { mode, trustNetwork: trustNetwork === true, ...named };
		}
		case "password": {
			const {
				passwordEnv = DEFAULT_PASSWORD_ENV,
				sessionDays = DEFAULT_SESSION_DAYS,
			} = auth as { passwordEnv?: unknown; sessionDays?: unknown };
			if (typeof passwordEnv !== "string" || !passwordEnv.trim())
				fail("auth.passwordEnv is empty");
			if (
				typeof sessionDays !== "number" ||
				!Number.isInteger(sessionDays) ||
				sessionDays < 1 ||
				sessionDays > 365
			)
				fail("auth.sessionDays must be a whole number of days from 1 to 365");
			return {
				mode,
				passwordEnv: passwordEnv.trim(),
				sessionDays,
				...named,
			};
		}
		case "verifier": {
			const given = (auth as { verifier?: unknown }).verifier;
			if (typeof given !== "function")
				fail(
					"auth.verifier is not a function; pass `cloudflareAccess({...})` or your own",
				);
			return { mode, verifier: given as RequestVerifier };
		}
		case "oidc":
			return checkOidc(auth as OidcOptions);
		default:
			fail(
				`auth.mode ${JSON.stringify(mode)} is unknown; the modes are none, password, verifier and oidc`,
			);
	}
}

const isHttpsUrl = (value: unknown): value is string =>
	typeof value === "string" && URL.parse(value)?.protocol === "https:";

/** A provider on this machine, which a test or a local identity provider may use over plain http. */
const isLoopbackHttp = (value: unknown): boolean => {
	const url = typeof value === "string" ? URL.parse(value) : null;
	return (
		url?.protocol === "http:" &&
		["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
	);
};

const providerUrl = (value: unknown): value is string =>
	isHttpsUrl(value) || isLoopbackHttp(value);

function checkOidc(auth: OidcOptions): ResolvedOidc {
	const known = new Set([
		"mode",
		"issuer",
		"discoveryUrl",
		"clientId",
		"clientSecretEnv",
		"scopes",
		"subjectClaim",
		"nameClaim",
		"rolesClaim",
		"check",
		"sessionDays",
		"endSession",
		"reauthHours",
		"storeClaims",
	]);
	for (const key of Object.keys(auth))
		if (!known.has(key)) fail(`auth.${key} is not an oidc option`);
	if (!providerUrl(auth.issuer))
		fail("auth.issuer must be the provider's https URL, exactly its `iss`");
	const { issuer } = auth;
	const discoveryUrl =
		auth.discoveryUrl ??
		`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
	if (!providerUrl(discoveryUrl))
		fail("auth.discoveryUrl must be an https URL");
	if (typeof auth.clientId !== "string" || !auth.clientId.trim())
		fail("auth.clientId is empty");
	if (
		auth.clientSecretEnv !== undefined &&
		(typeof auth.clientSecretEnv !== "string" || !auth.clientSecretEnv.trim())
	)
		fail(
			"auth.clientSecretEnv must name an environment variable; leave it out for a public client",
		);
	const scopes = auth.scopes ?? ["openid", "profile"];
	if (
		!Array.isArray(scopes) ||
		scopes.length === 0 ||
		!scopes.every(
			(scope) =>
				typeof scope === "string" && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope),
		)
	)
		fail("auth.scopes must be a list of scope names");
	if (scopes.includes("offline_access"))
		fail(
			"auth.scopes has offline_access, but the app keeps no refresh token: its own session is what lasts",
		);
	if (!scopes.includes("openid")) fail("auth.scopes must include openid");
	const claim = (name: string, value: unknown) => {
		if (value !== undefined && (typeof value !== "string" || !value.trim()))
			fail(`auth.${name} must be the name of a claim`);
	};
	claim("subjectClaim", auth.subjectClaim);
	claim("nameClaim", auth.nameClaim);
	if (
		auth.rolesClaim !== undefined &&
		auth.rolesClaim !== false &&
		(typeof auth.rolesClaim !== "string" || !auth.rolesClaim.trim())
	)
		fail("auth.rolesClaim must be the name of a claim, or false");
	if (auth.check !== undefined && typeof auth.check !== "function")
		fail("auth.check must be a function");
	const sessionDays = auth.sessionDays ?? DEFAULT_SESSION_DAYS;
	if (
		typeof sessionDays !== "number" ||
		!Number.isInteger(sessionDays) ||
		sessionDays < 1 ||
		sessionDays > 365
	)
		fail("auth.sessionDays must be a whole number of days from 1 to 365");
	if (auth.endSession !== undefined && typeof auth.endSession !== "boolean")
		fail("auth.endSession must be true or false");
	if (
		auth.reauthHours !== undefined &&
		(typeof auth.reauthHours !== "number" ||
			!(auth.reauthHours > 0) ||
			auth.reauthHours > sessionDays * 24)
	)
		fail(
			"auth.reauthHours must be a number of hours above 0 and within the session's own days",
		);
	const storeClaims = auth.storeClaims ?? [];
	if (
		!Array.isArray(storeClaims) ||
		!storeClaims.every((name) => typeof name === "string" && name.trim())
	)
		fail("auth.storeClaims must be a list of claim names");
	return {
		mode: "oidc",
		issuer,
		discoveryUrl,
		clientId: auth.clientId.trim(),
		clientSecretEnv: auth.clientSecretEnv?.trim(),
		scopes: [...scopes],
		subjectClaim: auth.subjectClaim?.trim() ?? "sub",
		nameClaim: auth.nameClaim?.trim(),
		rolesClaim:
			auth.rolesClaim === undefined
				? "roles"
				: typeof auth.rolesClaim === "string"
					? auth.rolesClaim.trim()
					: false,
		check: auth.check,
		sessionDays,
		endSession: auth.endSession === true,
		reauthHours: auth.reauthHours,
		storeClaims: [...storeClaims],
	};
}

function checkSurface(surface: string | undefined): string {
	if (surface === undefined) return DEFAULT_SURFACE;
	if (typeof surface !== "string" || !/^[a-z][a-z0-9-]*$/.test(surface))
		fail(
			`surface ${JSON.stringify(surface)} must be a lower-case word such as app`,
		);
	if (surface === "discord")
		fail("surface cannot be discord, whose channels the Discord plugin serves");
	return surface;
}

function checkGrace(seconds: number | undefined): number {
	if (seconds === undefined) return DEFAULT_CARD_GRACE_SECONDS;
	if (typeof seconds !== "number" || !(seconds > 0) || seconds > 3600)
		fail(
			"cardGraceSeconds must be a number of seconds above 0 and at most 3600",
		);
	return seconds;
}

function checkQuietHours(
	value: QuietWindow | false | undefined,
): QuietWindow | undefined {
	if (value === undefined) return { ...DEFAULT_QUIET_HOURS };
	if (value === false) return undefined;
	const bad = () =>
		fail(
			'push.quietHours must be false or {start, end} as two different HH:MM times, such as {start: "23:00", end: "08:00"}',
		);
	if (typeof value !== "object" || value === null) return bad();
	const { start, end } = value as Partial<QuietWindow>;
	if (typeof start !== "string" || typeof end !== "string") return bad();
	const from = minutesOfDay(start);
	const to = minutesOfDay(end);
	if (from === undefined || to === undefined || from === to) return bad();
	return { start, end };
}

function checkPush(
	options: WebConsoleOptions,
	origin: string,
): ResolvedOptions["push"] {
	const push = options.push;
	if (push?.preview !== undefined && typeof push.preview !== "boolean")
		fail("push.preview must be true or false");
	const quietHours = checkQuietHours(push?.quietHours);
	const hosts = push?.endpointHosts ?? [];
	if (!Array.isArray(hosts))
		fail("push.endpointHosts must be a list of host names");
	for (const host of hosts)
		if (typeof host !== "string" || !isHostPattern(host))
			fail(
				`push.endpointHosts has ${JSON.stringify(host)}, which is not a host name such as push.example.com or *.push.example.com`,
			);
	const given = push?.subject;
	if (
		given !== undefined &&
		!(
			typeof given === "string" &&
			(/^mailto:[^\s@]+@[^\s@]+$/.test(given) ||
				(URL.parse(given)?.protocol === "https:" && !/\s/.test(given)))
		)
	)
		fail(
			"push.subject must be a mailto: address or an https: URL, such as mailto:ops@example.com",
		);
	const tiers = push?.tiers ?? ["owner"];
	if (
		!Array.isArray(tiers) ||
		tiers.length === 0 ||
		!tiers.every((tier) => TIERS.includes(tier))
	)
		fail(`push.tiers must be a list of ${TIERS.join(", ")}`);
	const sender = push?.sender ?? "internal";
	if (sender !== "internal") {
		const external = (sender as { external?: unknown } | null)?.external as
			| { publicKey?: unknown; subscribePath?: unknown }
			| undefined;
		if (
			typeof external !== "object" ||
			external === null ||
			typeof external.publicKey !== "string" ||
			!/^[A-Za-z0-9_-]{80,100}$/.test(external.publicKey) ||
			(external.subscribePath !== undefined &&
				(typeof external.subscribePath !== "string" ||
					!external.subscribePath.startsWith("/")))
		)
			fail(
				'push.sender must be "internal" or { external: { publicKey, subscribePath? } } with the VAPID public key (base64url) and, when the sender serves the subscription routes, their path',
			);
	}
	const content = push?.content ?? (sender === "internal" ? "full" : "none");
	if (content !== "full" && content !== "none")
		fail('push.content must be "full" or "none"');
	const extra = push?.transports ?? [];
	if (
		!Array.isArray(extra) ||
		!extra.every(
			(name) => typeof name === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(name),
		)
	)
		fail("push.transports must be a list of transport names such as slack");
	return {
		preview: push?.preview ?? true,
		quietHours,
		endpointHosts: [...hosts],
		subject: given ?? (origin.startsWith("https:") ? origin : undefined),
		fetch: pushFetchOf(options),
		tiers: [...new Set(tiers)],
		sender:
			sender === "internal"
				? "internal"
				: {
						external: {
							publicKey: (sender as { external: { publicKey: string } })
								.external.publicKey,
							...((sender as { external: { subscribePath?: string } }).external
								.subscribePath
								? {
										subscribePath: (
											sender as { external: { subscribePath: string } }
										).external.subscribePath,
									}
								: {}),
						},
					},
		content,
		transports: [
			"web-push",
			...new Set(extra.filter((name) => name !== "web-push")),
		],
	};
}

function checkOnboarding(
	options: WebConsoleOptions,
): ResolvedOptions["onboarding"] {
	const given = options.onboarding;
	if (given === undefined) return { links: {}, push: "off", pushWaiver: false };
	if (typeof given !== "object" || given === null)
		fail("onboarding must be an object such as { links: { line: 'nudge' } }");
	const links = given.links ?? {};
	if (typeof links !== "object" || links === null || Array.isArray(links))
		fail("onboarding.links must map a provider to required or nudge");
	for (const [provider, step] of Object.entries(links)) {
		if (!provider.trim())
			fail("onboarding.links names a provider with an empty name");
		if (step !== "required" && step !== "nudge")
			fail(
				`onboarding.links.${provider} must be required or nudge, not ${JSON.stringify(step)}`,
			);
	}
	const push = given.push ?? "off";
	if (push !== "required" && push !== "nudge" && push !== "off")
		fail("onboarding.push must be required, nudge or off");
	if (given.pushWaiver !== undefined && typeof given.pushWaiver !== "boolean")
		fail("onboarding.pushWaiver must be true or false");
	return { links: { ...links }, push, pushWaiver: given.pushWaiver === true };
}

function checkUploads(options: WebConsoleOptions): number {
	const days = options.uploads?.keepDays;
	if (days === undefined) return 30;
	if (!Number.isInteger(days) || days < 1 || days > 3650)
		fail("uploads.keepDays must be a whole number of days from 1 to 3650");
	return days;
}

/** The largest `uploadMaxBytes`: the limit is also the listener's body limit. */
const MAX_UPLOAD_MAX_BYTES = 4 * 1024 ** 3;

function checkUploadMax(bytes: number | undefined): number {
	if (bytes === undefined) return DEFAULT_UPLOAD_MAX_BYTES;
	if (
		typeof bytes !== "number" ||
		!Number.isSafeInteger(bytes + UPLOAD_FRAMING_BYTES) ||
		bytes < 1 ||
		bytes > MAX_UPLOAD_MAX_BYTES
	)
		fail(
			"uploadMaxBytes must be a whole number of bytes, from 1 to 4 GiB, that the upload route can ask the listener to take with the form's framing added",
		);
	return bytes;
}

/** Checks the options at the point the plugin is created, so a bad setting stops the host before anything starts. */
export function resolveOptions(options: WebConsoleOptions): ResolvedOptions {
	const auth = checkAuth(options);
	if (
		options.routing !== undefined &&
		options.routing !== "path" &&
		options.routing !== "hash"
	)
		fail("routing must be hash or path");
	if (options.presentation?.locale !== undefined) {
		try {
			new Intl.DateTimeFormat(options.presentation.locale);
		} catch {
			fail("presentation.locale is not a valid locale");
		}
	}
	const admission = options.admission ?? "owners";
	if (admission !== "owners" && admission !== "access")
		fail('admission must be "owners" or "access"');
	if (
		admission === "access" &&
		(auth.mode === "none" || auth.mode === "password")
	)
		fail(
			`admission "access" needs a credential that names a person, but auth ${auth.mode} speaks for one shared actor; use auth oidc or a verifier that reports who signed in`,
		);
	const origin = checkOrigin(options.origin);
	if (auth.mode === "oidc" && !origin.startsWith("https:"))
		fail("auth oidc needs an https origin: the session cookie is Secure");
	if (options.modes !== undefined && options.modes !== false)
		fail("modes can only be false, to leave the mode switches out");
	const panes = checkPanes(options.panes, admission);
	const ownerId = options.ownerId?.trim();
	if (options.ownerId !== undefined && !ownerId)
		fail(
			"ownerId is empty. Leave it out: the console finds each visitor's principal, and a verifier that reports no actor speaks for the primary owner",
		);
	const look = options.appearance?.look ?? "modern";
	if (look !== "modern" && look !== "camelot")
		fail("appearance.look must be modern or camelot");
	const title = options.title?.trim() ?? "Roundtable";
	if (!title) fail("title is empty");
	const description = options.description?.trim();
	if (
		options.description !== undefined &&
		(typeof options.description !== "string" || !description)
	)
		fail("description is empty. Leave it out for the default");
	return {
		auth,
		origin,
		ownerId,
		dataDir: options.dataDir ?? "data",
		sessionsDir: join(options.dataDir ?? "data", "sessions"),
		mount: checkMount(options.mountPath ?? "/console"),
		listener: options.listener ?? "public",
		routing: options.routing ?? "hash",
		admission,
		panes: panes.owner,
		tierPanes: { owner: panes.owner, admin: panes.admin, member: panes.member },
		panesGiven: panes.given,
		workspace: checkWorkspace(options, options.dataDir ?? "data"),
		surface: checkSurface(options.surface),
		cardGraceSeconds: checkGrace(options.cardGraceSeconds),
		uploadMaxBytes: checkUploadMax(options.uploadMaxBytes),
		push: checkPush(options, origin),
		onboarding: checkOnboarding(options),
		modes: options.modes !== false,
		uploadKeepDays: checkUploads(options),
		title,
		description,
		iconsDir: options.icons?.dir,
		look,
		relayNotes: options.relayNotes ?? [DEFAULT_RELAY_NOTE],
		exclude: options.exclude,
		assetDir: options.assetDir,
		features: options.features,
		presentation: options.presentation,
	};
}

/** The directories the workspace pane shows: the agents' own, then the host's `workspace.roots`. */
export function workspaceRootsOf(
	settings: ResolvedOptions,
	agents: { workDir: string; scratchDir?: string } | undefined,
): WorkspaceRoot[] {
	const roots: WorkspaceRoot[] = [];
	if (agents && settings.workspace.agents)
		roots.push({
			id: "agents",
			label: "Agents' workspace",
			dir: agents.workDir,
			writable: true,
		});
	if (agents?.scratchDir && settings.workspace.scratch)
		roots.push({
			id: "scratch",
			label: "Scratch",
			dir: agents.scratchDir,
			writable: true,
		});
	return [...roots, ...settings.workspace.roots];
}

/**
 * Roots the default pane list may show. A directory of the agents that holds the host's data would
 * stop the host from starting after an upgrade that only added a pane, so such a root is left out,
 * with the reason; the roots a host names itself are kept, and `checkRoots` fails on them.
 */
export function showableRoots(
	roots: readonly WorkspaceRoot[],
	guarded: readonly string[],
): { roots: WorkspaceRoot[]; left: { id: string; reason: string }[] } {
	const kept: WorkspaceRoot[] = [];
	const left: { id: string; reason: string }[] = [];
	for (const root of roots) {
		if (root.id !== "agents" && root.id !== "scratch") {
			kept.push(root);
			continue;
		}
		try {
			checkRoots([root], guarded);
			kept.push(root);
		} catch (error) {
			left.push({
				id: root.id,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { roots: kept, left };
}
