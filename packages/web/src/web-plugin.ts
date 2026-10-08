import {
	AGENTS,
	CONVERSATIONS,
	definePlugin,
	IDENTITY,
	MEMORY,
	type RoundtablePlugin,
} from "pi-roundtable";
import { DISCORD } from "pi-roundtable/discord";
import { loadAssets } from "./assets.ts";
import { ConsoleApi } from "./console-api.ts";
import { ConsoleServer } from "./console-server.ts";
import {
	type ResolvedOptions,
	resolveOptions,
	type WebConsoleOptions,
} from "./options.ts";
import { consoleVisitors } from "./visitors.ts";

/**
 * The owners' web console: conversations, transcripts, memory notes, and the agent team, served
 * on a route of the host's listener and updated live. Every request needs the verifier to vouch
 * for the person and `IDENTITY` to name them an owner. The options are checked here, so a missing
 * verifier or a bad setting throws when the config is loaded.
 */
export function webConsole(options: WebConsoleOptions): RoundtablePlugin {
	const settings = resolveOptions(options);
	return definePlugin({
		name: "web-console",
		requires: [
			IDENTITY,
			...(settings.panes.includes("overview") ? [AGENTS] : []),
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
		...(settings.presentation ? { presentation: settings.presentation } : {}),
	});
	const server = new ConsoleServer({
		mount: settings.mount,
		assets,
		verifier: settings.verifier,
		identify: consoleVisitors(identity, {
			logger,
			...(settings.ownerId ? { ownerId: settings.ownerId } : {}),
		}),
		origin: settings.origin,
		pathRouting: settings.routing === "path",
		...(settings.presentation ? { presentation: settings.presentation } : {}),
		api,
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
				start: () => server.start(),
				stop: () => server.stop(),
			},
		],
		http: server.routes(settings.listener),
		dashboard: [`Web console: ${settings.origin}${settings.mount}/`],
	};
}
