import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	AGENTS,
	CONVERSATIONS,
	definePlugin,
	IDENTITY,
	MEMORY,
	MODES,
	PROFILES,
	PROMPTS,
	ROOM_LAYOUT,
	type RoundtablePlugin,
	SCHEDULES,
	SKILLS,
} from "pi-roundtable";
import { DISCORD } from "pi-roundtable/discord";
import type { PaneName } from "./api-types.ts";
import { APP_MIGRATIONS, OwnerApp } from "./app/app.ts";
import { APP_PROTOCOL } from "./app/protocol.ts";
import { UPLOAD_FRAMING_BYTES } from "./app/uploads.ts";
import { checkRoots, WorkspaceFiles } from "./app/workspace-files.ts";
import { loadAssets } from "./assets.ts";
import {
	createAuthenticator,
	WEB_CONSOLE_IDENTITY,
} from "./auth/authenticator.ts";
import { WebSessions } from "./auth/sessions.ts";
import { startOidc } from "./auth/start-oidc.ts";
import { ConsoleApi } from "./console-api.ts";
import { ConsoleServer } from "./console-server.ts";
import { Gate } from "./gate.ts";
import {
	protectedDirs,
	type ResolvedOptions,
	resolveOptions,
	type WebConsoleOptions,
} from "./options.ts";
import { loadVapid } from "./push/vapid.ts";
import { accessVisitors, consoleVisitors } from "./visitors.ts";
import { WEB_APP, WebAppRegistry } from "./web-app.ts";
import { checkRegistered } from "./web-plugin-checks.ts";
import { accessViewOf, hostedLinks } from "./web-plugin-hosted.ts";
import { mountWebhooks } from "./webhooks/mount.ts";
import { WebhookStore } from "./webhooks/store.ts";
import { type WebhooksSlot, webhookTools } from "./webhooks/tools.ts";
import { showableRoots, workspaceRootsOf } from "./workspace-roots.ts";

/** How often sessions past their limit are deleted: daily. */
const SESSION_SWEEP_MS = 86_400_000;

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
	// The agents' webhook tools are defined with the plugin; they reach the webhooks once it is set up.
	const slot: WebhooksSlot = {};
	const migrations = [
		...(rooms ? [...APP_MIGRATIONS, WebhookStore.migration] : []),
		...(auth.mode === "oidc"
			? [WebSessions.migration, WebSessions.jsonValuesMigration]
			: []),
	];
	return definePlugin({
		name: "web-console",
		...(migrations.length > 0 ? { migrations } : {}),
		provides: rooms ? [WEB_APP, ROOM_LAYOUT] : [WEB_APP],
		...(rooms ? { tools: webhookTools(slot) } : {}),
		// `none` and `password` speak for one principal through this identity; a verifier or a sign-in brings its own.
		...(auth.mode !== "none" && auth.mode !== "password"
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
			// A list that names the notes pane needs the memory; the default list drops it without one.
			...(settings.panesGiven && settings.panes.includes("notes")
				? [MEMORY]
				: []),
		],
		setup: (context) => build(settings, context, slot),
	});
}

type Context = Parameters<RoundtablePlugin["setup"]>[0];

async function build(
	settings: ResolvedOptions,
	context: Context,
	slot: WebhooksSlot,
) {
	const { services, queue, logger, env } = context;
	// What the other plugins register their rooms, pages and steps in: sealed when the web service starts.
	const webApp = new WebAppRegistry(settings.surface);
	services.provide(WEB_APP, webApp);
	const external = settings.push.sender !== "internal";
	const vapidFile = join(settings.dataDir, "web", "vapid.json");
	// An external sender holds the key: the app never makes or reads one, and a leftover file would say it does.
	if (external && existsSync(vapidFile))
		throw new Error(
			`web-console: push.sender is external, but ${vapidFile} exists. The app must not hold a push key: delete the file (devices subscribe again against the sender's key)`,
		);
	if (settings.admission === "access" && env.agentTools === "full")
		logger.warn(
			"web-console: admission is access and the agents carry shell tools. Anyone who can write the database can make a web session, and an agent with a shell can; keep admission owners behind a signing proxy, or run the agent server with tools chat-only",
		);
	const features =
		typeof settings.features === "function"
			? await settings.features(context)
			: settings.features;
	// The Connectors page also serves the MCP authorizations alone.
	const served = {
		skills: features?.skills,
		connectors: features?.connectors ?? features?.mcpGrants,
	};
	for (const pane of ["skills", "connectors"] as const) {
		if (settings.panes.includes(pane) && !served[pane])
			throw new Error(`web-console: the ${pane} pane needs its feature port`);
	}
	const rooms = settings.panes.includes("rooms");
	const agents = services.find(AGENTS);
	const team = agents?.team;
	const guarded = protectedDirs(settings.dataDir);
	let workspaceRoots = settings.panes.includes("workspace")
		? workspaceRootsOf(settings, agents?.workspace)
		: [];
	if (!settings.panesGiven) {
		const shown = showableRoots(workspaceRoots, guarded);
		for (const { id, reason } of shown.left)
			logger.warn(
				{ root: id },
				`the files pane leaves out the ${id} directory: ${reason}`,
			);
		workspaceRoots = shown.roots;
	}
	// The default list shows the files pane only when there is something to show; a list that
	// names it must have a directory.
	if (settings.panes.includes("workspace") && workspaceRoots.length === 0) {
		if (settings.panesGiven)
			throw new Error(
				"web-console: the workspace pane needs a directory to show: the agents' workspace (the agent server provides it) or workspace.roots",
			);
	}
	// The default list shows the notes pane only when the host keeps memory.
	const memory = services.find(MEMORY);
	const withoutNotes = !settings.panesGiven && memory === undefined;
	if (withoutNotes && settings.panes.includes("notes"))
		logger.warn("the notes pane is left out: this host keeps no memory");
	const servable = (pane: PaneName) =>
		(pane !== "workspace" || workspaceRoots.length > 0) &&
		(pane !== "notes" || !withoutNotes);
	const panes = settings.panes.filter(servable);
	const tierPanes = {
		owner: panes,
		admin: settings.tierPanes.admin.filter(servable),
		member: settings.tierPanes.member.filter(servable),
	};
	if (workspaceRoots.length > 0) checkRoots(workspaceRoots, guarded);
	const workspace =
		panes.includes("workspace") && rooms
			? new WorkspaceFiles({
					roots: workspaceRoots,
					logger,
					protectedDirs: guarded,
				})
			: undefined;
	const connection = services.find(DISCORD)?.connection;
	// Absent on a host without the registry: the console then lists conversations found by name only.
	const registry = services.find(CONVERSATIONS);
	const identity = services.get(IDENTITY);
	const profiles = services.find(PROFILES);
	if (settings.admission === "access" && !profiles)
		throw new Error(
			"web-console: admission access needs the PROFILES service; a plugin that replaces IDENTITY must provide PROFILES too",
		);
	// An agent's skills are chosen from what the Skills pane lists when the host supplies it, else from the addon's own catalog.
	const skillRegistry = services.find(SKILLS);
	const skills = skillRegistry
		? {
				catalog: () =>
					features?.skills
						? features.skills.catalog()
						: skillRegistry.catalog(),
				carried: (agent: string) => skillRegistry.carried(agent).skills,
				attach: (
					agent: string,
					add: readonly string[],
					remove: readonly string[],
				) => skillRegistry.attach(agent, add, remove),
				documents: skillRegistry,
				groups: skillRegistry,
			}
		: undefined;
	// The prompts plugin is always on; a host that replaced it may leave it out.
	const prompts = services.find(PROMPTS);
	const listeners: (() => void)[] = [];
	const changed = () => {
		for (const listener of listeners) listener();
	};
	// A broken page stops startup here, before anything connects.
	const assets = loadAssets(settings.assetDir);
	const gate = new Gate({ registry: webApp });
	const hosted = hostedLinks(webApp, logger);
	const access = accessViewOf(settings, gate);
	const api = new ConsoleApi({
		title: settings.title,
		timeZone: env.timeZone,
		panes,
		tierPanes,
		...(access ? { access } : {}),
		hosted,
		sessionsDir: settings.sessionsDir,
		...(team ? { team } : {}),
		...(team && rooms ? { roomSurface: settings.surface } : {}),
		queue,
		...(connection
			? { channelName: (id: string) => connection.channelInfo(id) }
			: {}),
		...(panes.includes("notes") && memory
			? { memoryOf: (principalId: string) => memory.forSpeaker(principalId) }
			: {}),
		people: identity,
		...(settings.exclude ? { exclude: settings.exclude } : {}),
		...(registry ? { registry } : {}),
		relayNotes: settings.relayNotes,
		changed,
		logger,
		...(features ? { features } : {}),
		look: settings.look,
		characterSkins: env.characterSkins,
		...(settings.routing === "path" ? { mountPath: settings.mount } : {}),
		...(rooms
			? {
					app: {
						surface: settings.surface,
						protocol: APP_PROTOCOL,
						...(settings.modes ? {} : { modes: false as const }),
					},
				}
			: {}),
		...(settings.presentation ? { presentation: settings.presentation } : {}),
	});
	const identify =
		settings.admission === "access"
			? accessVisitors(identity, { surface: settings.surface, logger })
			: consoleVisitors(identity, {
					logger,
					...(settings.ownerId ? { ownerId: settings.ownerId } : {}),
				});
	// An open socket closes when its session ends; the app is made after the sign-in it hangs on.
	let sessionEnded: (id: string) => void = () => undefined;
	let sweeper: ReturnType<typeof setInterval> | undefined;
	const sessions =
		settings.auth.mode === "oidc"
			? new WebSessions(context.database(), { days: settings.auth.sessionDays })
			: undefined;
	const oidc =
		settings.auth.mode === "oidc" && sessions
			? await startOidc(settings.auth, {
					sessions,
					settings,
					identify,
					logger,
					events: context.events,
					ended: (id) => sessionEnded(id),
				})
			: undefined;
	const authenticator = createAuthenticator({
		auth: settings.auth,
		identify,
		...(oidc && sessions
			? {
					oidc: {
						login: oidc,
						sessions,
						reauthHours:
							settings.auth.mode === "oidc"
								? settings.auth.reauthHours
								: undefined,
					},
				}
			: {}),
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
	if (rooms && !external && !settings.push.subject)
		logger.warn(
			"web push is off: the origin is not https, so set push.subject to a mailto: or https: contact",
		);
	const vapid = rooms && !external ? await loadVapid(vapidFile) : undefined;
	const app =
		rooms && (vapid || external)
			? new OwnerApp({
					timeZone: env.timeZone,
					...(settings.presentation
						? { presentation: settings.presentation }
						: {}),
					extras: {
						...(profiles ? { profiles } : {}),
						routing: settings.routing,
						onboarding: settings.onboarding,
						push: settings.push,
					},
					push: {
						...(vapid ? { vapid } : {}),
						subject: settings.push.subject,
						preview: settings.push.preview,
						...(settings.push.quietHours
							? { quietHours: settings.push.quietHours }
							: {}),
						timeZone: env.timeZone,
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
					uploadKeepDays: settings.uploadKeepDays,
					events: context.events,
					// The name the person goes by in the app, as the profiles name them.
					...(profiles
						? { nameOf: async (id: string) => (await profiles.of(id)).name }
						: {}),
					roomUrl: (room, message) =>
						`${settings.routing === "path" ? `${settings.mount}/room/` : `${settings.mount}/#/room/`}${encodeURIComponent(room)}${message === undefined ? "" : `?message=${message}`}`,
					authenticator,
					authMode: settings.auth.mode,
					admission: settings.admission,
					registry: webApp,
					gate,
					pushTiers: settings.push.tiers,
					modeSwitches: settings.modes,
					// A password session outlives a logout or a new password on an open socket, so the socket is capped.
					...(settings.auth.mode === "password"
						? { socketLifeMs: PASSWORD_SOCKET_LIFE_MS }
						: {}),
					database: context.database(),
					agents: services.get(AGENTS),
					...(skills ? { skills } : {}),
					chatCommands: context.chatCommands,
					...(prompts ? { prompts } : {}),
					...(workspace ? { workspace } : {}),
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
	if (app) {
		services.provide(ROOM_LAYOUT, app.roomLayout);
		listeners.push(() => app.changed());
		sessionEnded = (id) => app.sessionEnded(id);
	}
	const server = new ConsoleServer({
		mount: settings.mount,
		assets,
		authenticator,
		pathRouting: settings.routing === "path",
		title: settings.title,
		origin: settings.origin,
		...(settings.description ? { description: settings.description } : {}),
		...(settings.iconsDir ? { iconsDir: settings.iconsDir } : {}),
		look: settings.look,
		...(settings.presentation ? { presentation: settings.presentation } : {}),
		api,
		...(app
			? {
					app,
					webhooks: mountWebhooks({
						database: context.database(),
						directory: services.get(AGENTS).directory,
						surface: app.surface,
						origin: settings.webhookOrigin,
						mount: settings.mount,
						...(settings.presentation
							? { presentation: settings.presentation }
							: {}),
						slot,
						logger,
					}),
				}
			: {}),
		gate,
		surface: settings.surface,
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
					checkRegistered(settings, webApp);
					webApp.seal();
					server.start();
					app?.start();
					if (sessions) {
						const sweep = () =>
							sessions
								.sweep()
								.catch((error: unknown) =>
									logger.warn(
										{ err: error },
										"old web sessions were not deleted",
									),
								);
						sweep();
						sweeper = setInterval(sweep, SESSION_SWEEP_MS);
					}
				},
				stop: () => {
					clearInterval(sweeper);
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
