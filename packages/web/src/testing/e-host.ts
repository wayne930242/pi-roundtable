import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ActorFacts,
	definePlugin,
	IDENTITY,
	type RoundtablePlugin,
	type TurnRequest,
	type TurnResult,
} from "pi-roundtable";
import { type TestHost, testHost } from "pi-roundtable/testing";
import type { ServerFrame } from "../api-types.ts";
import { APP_PROTOCOL } from "../app/protocol.ts";
import type { WebConsoleOptions } from "../options.ts";
import { admitAs, refuse, type Verdict } from "../verifier.ts";
import { WEB_APP, type WebApp } from "../web-app.ts";
import { webConsole } from "../web-plugin.ts";
import { withPushFetch } from "./push.ts";

export const ORIGIN = "https://app.example.test";
export const ADA_DISCORD = "100000000000000001";
export const MEL_DISCORD = "200000000000000002";
export const ADA_LINE = "U00000000000000000000000000000001";
export const SAM_DISCORD = "300000000000000003";
const GUILD = "900000000000000761";
const ENTRY_CHANNEL = "900000000000000762";

export const ADA: ActorFacts = {
	provider: "discord",
	subject: ADA_DISCORD,
	name: "Ada",
};
export const MEL: ActorFacts = {
	provider: "discord",
	subject: MEL_DISCORD,
	name: "Mel",
};
export const SAM: ActorFacts = {
	provider: "discord",
	subject: SAM_DISCORD,
	name: "Sam",
};

const ACTORS: Record<string, ActorFacts> = { owner: ADA, mel: MEL, sam: SAM };

/** The verifier of these suites: the header `x-actor` names who the proxy vouches for. */
function verifier(request: Request): Verdict {
	const actor = ACTORS[request.headers.get("x-actor") ?? ""];
	return actor ? admitAs(actor) : refuse("no proxy assertion");
}

export interface EHost {
	host: TestHost;
	socket: string;
	dataDir: string;
	/** What the plugins under test registered. */
	app: WebApp;
	stop(): Promise<void>;
}

const runtime = {
	runTurn: async (request: TurnRequest): Promise<TurnResult> => ({
		ok: true,
		text: `echo ${request.text}`,
	}),
	steer: async () => false,
	stop: () => false,
	startFresh: async () => undefined,
	deleteConversation: async () => undefined,
	pendingConfirmation: () => undefined,
	heldActions: async () => undefined,
	recentTranscript: async () => [],
};

/**
 * Boots a host whose web app admits owners and members (`admission: "access"`) and in which the
 * actor header picks Ada (owner), Mel or Sam (members). `extra` plugins register against `WEB_APP`
 * from `setup`, like a host's would.
 */
export async function bootE(options: {
	fetch?: typeof fetch;
	console?: Partial<WebConsoleOptions>;
	extra?: (app: WebApp) => void | Promise<void>;
	/** Plugins besides the console. */
	plugins?: RoundtablePlugin[];
	dataDir?: string;
}): Promise<EHost> {
	const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "e-host-"));
	const socket = join(dataDir, "public.sock");
	const assets = mkdtempSync(join(tmpdir(), "e-host-page-"));
	writeFileSync(join(assets, "index.html"), "<html>app</html>");
	let app: WebApp | undefined;
	const registrar = definePlugin({
		name: "e-registrar",
		requires: [WEB_APP],
		setup: async ({ services }) => {
			app = services.get(WEB_APP);
			await options.extra?.(app);
			return {};
		},
	});
	const settings: WebConsoleOptions = {
		verifier,
		origin: ORIGIN,
		dataDir,
		assetDir: assets,
		admission: "access",
		panes: { owner: ["rooms", "profile"], member: ["profile"] },
		push: { quietHours: false },
		...options.console,
	} as WebConsoleOptions;
	const host = await testHost({
		config: {
			dataDir,
			discord: { token: "token", guild: GUILD, entryChannel: ENTRY_CHANNEL },
			http: { publicUrl: "https://bot.example.com", socketPath: socket },
			access: {
				owners: [
					{
						name: "Ada",
						principal: ADA_DISCORD,
						identities: [`discord:${ADA_DISCORD}`, `line:${ADA_LINE}`],
					},
				],
				members: {
					identities: [`discord:${MEL_DISCORD}`, `discord:${SAM_DISCORD}`],
				},
				provisioning: { app: "admitted" },
			},
			agents: [
				{
					name: "guide",
					displayName: "Guide",
					prompt: "You guide.",
					avatarPrompt: "A guide",
					channelId: ENTRY_CHANNEL,
				},
			],
		} as never,
		runtime,
		plugins: [
			webConsole(
				options.fetch ? withPushFetch(settings, options.fetch) : settings,
			),
			registrar,
			...(options.plugins ?? []),
		],
	});
	if (!app) throw new Error("the registrar did not run");
	return { host, socket, dataDir, app, stop: () => host.stop() };
}

/** The principal id of a speaker the host knows, admitting them first. */
export async function principalOf(host: TestHost, actor: ActorFacts) {
	const speaker = await host.context.services.get(IDENTITY).resolve(actor, {
		conversation: "app:session",
	});
	if (!speaker) throw new Error(`${actor.name} is not served`);
	return speaker.principalId;
}

/** A request to the app's REST over the host's unix socket. */
export function rest(
	boot: Pick<EHost, "socket">,
	path: string,
	init: RequestInit & { who?: string; origin?: string | null } = {},
): Promise<Response> {
	const { who = "owner", origin = ORIGIN, ...more } = init;
	return fetch(`http://localhost/console/api/${path}`, {
		...more,
		headers: {
			"x-actor": who,
			...(origin ? { origin } : {}),
			...(more.body ? { "content-type": "application/json" } : {}),
			...(more.headers as Record<string, string> | undefined),
		},
		unix: boot.socket,
	} as never);
}

/** One app WebSocket and the frames it received. */
export class Client {
	readonly frames: ServerFrame[] = [];
	#cursor = 0;
	readonly #ws: WebSocket;
	closed: { code: number } | undefined;

	private constructor(ws: WebSocket) {
		this.#ws = ws;
		ws.onmessage = (event) => {
			try {
				this.frames.push(JSON.parse(String(event.data)) as ServerFrame);
			} catch {
				// A test's server sends JSON; anything else is not a frame.
			}
		};
		ws.onclose = (event) => {
			this.closed = { code: event.code };
		};
	}

	static async open(
		boot: Pick<EHost, "socket">,
		who: string,
	): Promise<Client | undefined> {
		const ws = new WebSocket(`ws+unix://${boot.socket}:/console/api/socket`, {
			protocols: [APP_PROTOCOL],
			headers: { origin: ORIGIN, "x-actor": who },
		} as never);
		const opened = await new Promise<boolean>((resolve) => {
			ws.onopen = () => resolve(true);
			ws.onerror = () => resolve(false);
			ws.onclose = () => resolve(false);
		});
		return opened ? new Client(ws) : undefined;
	}

	send(frame: Record<string, unknown>): void {
		this.#ws.send(JSON.stringify(frame));
	}

	/** The first frame after the last one taken that `match` accepts; waits up to `ms`. */
	async take<T extends ServerFrame>(
		match: (frame: ServerFrame) => frame is T,
		ms?: number,
	): Promise<T>;
	async take(
		match: (frame: ServerFrame) => boolean,
		ms?: number,
	): Promise<ServerFrame>;
	async take(
		match: (frame: ServerFrame) => boolean,
		ms = 4000,
	): Promise<ServerFrame> {
		const deadline = Date.now() + ms;
		for (;;) {
			const at = this.frames.findIndex(
				(frame, index) => index >= this.#cursor && match(frame),
			);
			if (at >= 0) {
				this.#cursor = at + 1;
				return this.frames[at] as ServerFrame;
			}
			if (Date.now() > deadline)
				throw new Error(
					`no frame arrived; got ${this.frames.map((f) => f.type).join(", ")}`,
				);
			await Bun.sleep(10);
		}
	}

	/** Whether a frame matching shows up within `ms` (it is not taken). */
	async sees(
		match: (frame: ServerFrame) => boolean,
		ms = 300,
	): Promise<boolean> {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			if (this.frames.some((f, index) => index >= this.#cursor && match(f)))
				return true;
			await Bun.sleep(10);
		}
		return false;
	}

	close(): void {
		this.#ws.close();
	}
}

export const ofType =
	<K extends ServerFrame["type"]>(type: K) =>
	(frame: ServerFrame): frame is Extract<ServerFrame, { type: K }> =>
		frame.type === type;
