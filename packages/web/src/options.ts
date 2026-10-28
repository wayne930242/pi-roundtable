import { join } from "node:path";
import type { ChannelKey, RoundtablePlugin } from "pi-roundtable";
import { PluginError } from "pi-roundtable";
import { PANES, type PaneName } from "./api-types.ts";
import type { ConsoleFeatures, ConsolePresentation } from "./features.ts";
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
	/** The panes to serve, in the order the page lists them; default all of `overview`, `conversations`, `notes`. */
	panes?: readonly PaneName[];
	/** The page's title and heading; default `Roundtable`. */
	title?: string;
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
	title: string;
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
	if (panes === undefined) return ["overview", "conversations", "notes"];
	if (panes.length === 0) fail("panes is empty; serve at least one pane");
	for (const pane of panes)
		if (!PANES.includes(pane))
			fail(
				`unknown pane ${JSON.stringify(pane)}; the panes are ${PANES.join(", ")}`,
			);
	if (new Set(panes).size !== panes.length) fail("panes lists a pane twice");
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
		title,
		relayNotes: options.relayNotes ?? [DEFAULT_RELAY_NOTE],
		exclude: options.exclude,
		assetDir: options.assetDir,
		features: options.features,
		presentation: options.presentation,
	};
}
