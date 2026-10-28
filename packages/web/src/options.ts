import { join } from "node:path";
import type { ChannelKey, RoundtablePlugin } from "pi-roundtable";
import { PluginError } from "pi-roundtable";
import { PANES, type PaneName } from "./api-types.ts";
import {
	DEFAULT_UPLOAD_MAX_BYTES,
	UPLOAD_FRAMING_BYTES,
} from "./app/uploads.ts";
import type { ConsoleFeatures, ConsolePresentation } from "./features.ts";
import { isHostPattern } from "./push/endpoint.ts";
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
	  };

/** `auth` checked and filled in. */
export type ResolvedAuth =
	| { mode: "none"; trustNetwork: boolean; principal?: string }
	| {
			mode: "password";
			passwordEnv: string;
			sessionDays: number;
			principal?: string;
	  }
	| { mode: "verifier"; verifier: RequestVerifier };

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
	 * The panes to serve, in the order the page lists them; default `rooms`, `table`, `overview`,
	 * `schedules`, `conversations`, `notes`. `rooms` is the owner app: the same agent team as on
	 * Discord, in rooms of its own; `table` seats its agents at the round table and needs `rooms`.
	 * An explicit list is kept as written, so a host that listed the panes before 0.23 adds
	 * `rooms`, `table` and `schedules` by hand.
	 */
	panes?: readonly PaneName[];
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
	};
	/** The page's title and heading; default `Roundtable`. */
	title?: string;
	/** Where the install icons come from; default the ones this package ships. */
	icons?: { dir: string };
	/** How the page looks: `modern` (default) or `camelot`. The page's owner can switch it in the app. */
	appearance?: { look?: "modern" | "camelot" };
	/** Text a relayed message begins with, taken off the owner's words; default the remote MCP note. */
	relayNotes?: readonly string[];
	/** Conversations the console neither lists nor reads. */
	exclude?: (key: ChannelKey) => boolean;
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
	panes: PaneName[];
	surface: string;
	cardGraceSeconds: number;
	uploadMaxBytes: number;
	push: {
		preview: boolean;
		endpointHosts: readonly string[];
		/** The VAPID contact; undefined = push is off. */
		subject: string | undefined;
		fetch: typeof fetch | undefined;
	};
	title: string;
	iconsDir: string | undefined;
	look: "modern" | "camelot";
	relayNotes: readonly string[];
	exclude: ((key: ChannelKey) => boolean) | undefined;
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

function checkPanes(panes: readonly PaneName[] | undefined): PaneName[] {
	if (panes === undefined)
		return [
			"rooms",
			"table",
			"overview",
			"schedules",
			"conversations",
			"notes",
		];
	if (panes.length === 0) fail("panes is empty; serve at least one pane");
	for (const pane of panes)
		if (!PANES.includes(pane))
			fail(
				`unknown pane ${JSON.stringify(pane)}; the panes are ${PANES.join(", ")}`,
			);
	if (new Set(panes).size !== panes.length) fail("panes lists a pane twice");
	if (panes.includes("schedules") && !panes.includes("rooms"))
		fail("the schedules pane needs the rooms pane, which serves its API");
	if (panes.includes("table") && !panes.includes("rooms"))
		fail("the table pane needs the rooms pane, whose agents it seats");
	return [...panes];
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
		default:
			fail(
				`auth.mode ${JSON.stringify(mode)} is unknown; the modes are none, password and verifier`,
			);
	}
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

function checkPush(
	options: WebConsoleOptions,
	origin: string,
): ResolvedOptions["push"] {
	const push = options.push;
	if (push?.preview !== undefined && typeof push.preview !== "boolean")
		fail("push.preview must be true or false");
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
	return {
		preview: push?.preview ?? true,
		endpointHosts: [...hosts],
		subject: given ?? (origin.startsWith("https:") ? origin : undefined),
		fetch: pushFetchOf(options),
	};
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
	const panes = checkPanes(options.panes);
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
	return {
		auth,
		origin: checkOrigin(options.origin),
		ownerId,
		dataDir: options.dataDir ?? "data",
		sessionsDir: join(options.dataDir ?? "data", "sessions"),
		mount: checkMount(options.mountPath ?? "/console"),
		listener: options.listener ?? "public",
		routing: options.routing ?? "hash",
		panes,
		surface: checkSurface(options.surface),
		cardGraceSeconds: checkGrace(options.cardGraceSeconds),
		uploadMaxBytes: checkUploadMax(options.uploadMaxBytes),
		push: checkPush(options, checkOrigin(options.origin)),
		title,
		iconsDir: options.icons?.dir,
		look,
		relayNotes: options.relayNotes ?? [DEFAULT_RELAY_NOTE],
		exclude: options.exclude,
		assetDir: options.assetDir,
		features: options.features,
		presentation: options.presentation,
	};
}
