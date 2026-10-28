import { join } from "node:path";
import {
	AGENTS,
	CONVERSATIONS,
	definePlugin,
	IDENTITY,
	MEMORY,
	MODES,
	type RoundtablePlugin,
	SCHEDULES,
} from "pi-roundtable";
import { DISCORD } from "pi-roundtable/discord";
import { APP_MIGRATIONS, OwnerApp } from "./app/app.ts";
import { APP_PROTOCOL } from "./app/protocol.ts";
import { UPLOAD_FRAMING_BYTES } from "./app/uploads.ts";
import { loadAssets } from "./assets.ts";
import {
	createAuthenticator,
	WEB_CONSOLE_IDENTITY,
} from "./auth/authenticator.ts";
import { ConsoleApi } from "./console-api.ts";
import { ConsoleServer } from "./console-server.ts";
import {
	type ResolvedOptions,
	resolveOptions,
	type WebConsoleOptions,
} from "./options.ts";
import { loadVapid } from "./push/vapid.ts";
import { consoleVisitors } from "./visitors.ts";

/** The longest a WebSocket stays open under `password` auth: the session cookie is looked at again after this. */
const PASSWORD_SOCKET_LIFE_MS = 3_600_000;

/**
 * The owners' web console: conversations, transcripts, memory notes, and the agent team, served
 * on a route of the host's listener and updated live. Every request needs the configured `auth`
 * to vouch for the person and `IDENTITY` to name them an owner. The options are checked here, so
 * missing authentication or a bad setting throws when the config is loaded; whether `none` fits
 * the listener and whether the password is long enough are checked when the host sets up.
 */
export function webConsole(options: WebConsoleOptions): RoundtablePlugin {
	const settings = resolveOptions(options);
	const { auth } = settings;
	const rooms = settings.panes.includes("rooms");
	const schedules = settings.panes.includes("schedules");
	return definePlugin({
		name: "web-console",
		...(rooms ? { migrations: APP_MIGRATIONS } : {}),
		// `none` and `password` speak for one principal through this identity; a verifier brings its own.
		...(auth.mode === "verifier"
			? {}
			: {
					identities: [
						{
							identity: WEB_CONSOLE_IDENTITY,
							...(auth.principal ? { principal: auth.principal } : {}),
						},
					],
				}),
		requires: [
			IDENTITY,
			...(settings.panes.includes("overview") || rooms ? [AGENTS] : []),
			...(rooms ? [MODES] : []),
			...(schedules ? [SCHEDULES] : []),
			...(settings.panes.includes("notes") ? [MEMORY] : []),
		],
		setup: (context) => build(settings, context),
	});
}

type Context = Parameters<RoundtablePlugin["setup"]>[0];

async function build(settings: ResolvedOptions, context: Context) {
	const { services, queue, logger, env } = context;
	const features =
		typeof settings.features === "function"
			? await settings.features(context)
			: settings.features;
	for (const pane of ["skills", "connectors"] as const) {
		if (settings.panes.includes(pane) && !features?.[pane])
			throw new Error(`web-console: the ${pane} pane needs its feature port`);
	}
	const rooms = settings.panes.includes("rooms");
	const team = services.find(AGENTS)?.team;
	const connection = services.find(DISCORD)?.connection;
	// Absent on a host without the registry: the console then lists conversations found by name only.
	const registry = services.find(CONVERSATIONS);
	const identity = services.get(IDENTITY);
	const listeners: (() => void)[] = [];
	const changed = () => {
		for (const listener of listeners) listener();
	};
	// A broken page stops startup here, before anything connects.
	const assets = loadAssets(settings.assetDir);
	const api = new ConsoleApi({
		title: settings.title,
		timeZone: env.timeZone,
		panes: settings.panes,
		sessionsDir: settings.sessionsDir,
		...(team ? { team } : {}),
		queue,
		...(connection
			? { channelName: (id: string) => connection.channelInfo(id) }
			: {}),
		...(settings.panes.includes("notes")
			? {
					memoryOf: (principalId: string) =>
						services.get(MEMORY).forSpeaker(principalId),
				}
			: {}),
		people: identity,
		...(settings.exclude ? { exclude: settings.exclude } : {}),
		...(registry ? { registry } : {}),
		relayNotes: settings.relayNotes,
		changed,
		logger,
		...(features ? { features } : {}),
		...(settings.routing === "path" ? { mountPath: settings.mount } : {}),
		...(rooms
			? { app: { surface: settings.surface, protocol: APP_PROTOCOL } }
			: {}),
		...(settings.presentation ? { presentation: settings.presentation } : {}),
	});
	const authenticator = createAuthenticator({
		auth: settings.auth,
		identify: consoleVisitors(identity, {
			logger,
			...(settings.ownerId ? { ownerId: settings.ownerId } : {}),
		}),
		origin: settings.origin,
		mount: settings.mount,
		title: settings.title,
		...(settings.presentation ? { presentation: settings.presentation } : {}),
		logger,
		dataDir: settings.dataDir,
		listener: {
			id: settings.listener,
			address: context.listener(settings.listener),
		},
	});
	if (rooms && !settings.push.subject)
		logger.warn(
			"web push is off: the origin is not https, so set push.subject to a mailto: or https: contact",
		);
	const vapid = rooms
		? await loadVapid(join(settings.dataDir, "web", "vapid.json"))
		: undefined;
	const app =
		rooms && vapid
			? new OwnerApp({
					push: {
						vapid,
						subject: settings.push.subject,
						preview: settings.push.preview,
						endpointHosts: settings.push.endpointHosts,
						...(settings.push.fetch ? { fetch: settings.push.fetch } : {}),
						urlOf: (room) =>
							settings.routing === "path"
								? `${settings.mount}/room/${encodeURIComponent(room)}`
								: `${settings.mount}/#/room/${encodeURIComponent(room)}`,
					},
					surface: settings.surface,
					mount: settings.mount,
					origin: settings.origin,
					dataDir: settings.dataDir,
					cardGraceSeconds: settings.cardGraceSeconds,
					uploadMaxBytes: settings.uploadMaxBytes,
					authenticator,
					authMode: settings.auth.mode,
					// A password session outlives a logout or a new password on an open socket, so the socket is capped.
					...(settings.auth.mode === "password"
						? { socketLifeMs: PASSWORD_SOCKET_LIFE_MS }
						: {}),
					database: context.database(),
					agents: services.get(AGENTS),
					modes: services.get(MODES),
					identity,
					...(settings.panes.includes("schedules")
						? { schedules: services.get(SCHEDULES) }
						: {}),
					conversations: context.conversations,
					changed,
					logger,
				})
			: undefined;
	if (app) listeners.push(() => app.changed());
	const server = new ConsoleServer({
		mount: settings.mount,
		assets,
		authenticator,
		pathRouting: settings.routing === "path",
		title: settings.title,
		...(settings.iconsDir ? { iconsDir: settings.iconsDir } : {}),
		...(settings.presentation ? { presentation: settings.presentation } : {}),
		api,
		...(app ? { app } : {}),
		subscribe: (listener) => {
			listeners.push(listener);
			queue.onChange(listener);
			team?.onChange(listener);
		},
		logger,
	});
	return {
		services: [
			{
				name: "web-console",
				start: () => {
					server.start();
					app?.start();
				},
				stop: () => {
					app?.stop();
					server.stop();
				},
			},
		],
		...(app
			? { surfaces: [app.surface], directChannels: [app.directChannel] }
			: {}),
		// An upload is a form with one file in it: the limit of the file and its framing.
		http: server.routes(
			settings.listener,
			rooms ? settings.uploadMaxBytes + UPLOAD_FRAMING_BYTES : undefined,
		),
		dashboard: [`Web console: ${settings.origin}${settings.mount}/`],
	};
}
