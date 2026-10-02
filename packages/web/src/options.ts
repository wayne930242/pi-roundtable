import { join } from "node:path";
import type { ChannelKey } from "pi-roundtable";
import { PluginError } from "pi-roundtable";
import { PANES, type PaneName } from "./api-types.ts";
import type { RequestVerifier } from "./verifier.ts";

/**
 * The note pi-roundtable-mcp puts before a relayed message by default. A conversation opened over
 * remote MCP starts with it, so the console takes it off before showing the owner's words.
 */
export const DEFAULT_RELAY_NOTE =
	"(The owner wrote this in a personal agent that relays it over MCP, not on Discord. Answer the owner directly, just as you would on Discord; the agent passes your reply back.)";

export interface WebConsoleOptions {
	/**
	 * Decides whether a request comes from the owner; required. `cloudflareAccess(...)` is the
	 * built-in one. Without it the plugin refuses to start rather than serve without authentication.
	 */
	verifier: RequestVerifier;
	/**
	 * The console's own origin, such as `https://console.example.com`: requests that change data
	 * must carry it as their `Origin`, and the dashboard line links to it.
	 */
	origin: string;
	/** The id memory notes are kept under: the owner's. Required when the `notes` pane is served. */
	ownerId?: string;
	/** The host's data directory, whose `sessions/` holds the conversations; default `./data`. */
	dataDir?: string;
	/** The path the console is served under; default `/console`. */
	mountPath?: string;
	/** The listener whose address serves it; default `public`. */
	listener?: string;
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
	verifier: RequestVerifier;
	origin: string;
	ownerId: string | undefined;
	sessionsDir: string;
	mount: string;
	listener: string;
	panes: PaneName[];
	title: string;
	relayNotes: readonly string[];
	exclude: ((key: ChannelKey) => boolean) | undefined;
	assetDir: string | undefined;
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
	if (panes === undefined) return [...PANES];
	if (panes.length === 0) fail("panes is empty; serve at least one pane");
	for (const pane of panes)
		if (!PANES.includes(pane))
			fail(
				`unknown pane ${JSON.stringify(pane)}; the panes are ${PANES.join(", ")}`,
			);
	if (new Set(panes).size !== panes.length) fail("panes lists a pane twice");
	return [...panes];
}

/** Checks the options at the point the plugin is created, so a bad setting stops the host before anything starts. */
export function resolveOptions(options: WebConsoleOptions): ResolvedOptions {
	if (typeof options.verifier !== "function")
		fail(
			"no verifier. The console serves the owner's conversations and notes, so it will not start without one that authenticates every request; pass `verifier: cloudflareAccess({...})` or your own",
		);
	const panes = checkPanes(options.panes);
	const ownerId = options.ownerId?.trim();
	if (panes.includes("notes") && !ownerId)
		fail(
			"ownerId is required for the notes pane: it is the id the owner's memory is kept under. Set it, or leave `notes` out of panes",
		);
	const title = options.title?.trim() ?? "Roundtable";
	if (!title) fail("title is empty");
	return {
		verifier: options.verifier,
		origin: checkOrigin(options.origin),
		ownerId,
		sessionsDir: join(options.dataDir ?? "data", "sessions"),
		mount: checkMount(options.mountPath ?? "/console"),
		listener: options.listener ?? "public",
		panes,
		title,
		relayNotes: options.relayNotes ?? [DEFAULT_RELAY_NOTE],
		exclude: options.exclude,
		assetDir: options.assetDir,
	};
}
