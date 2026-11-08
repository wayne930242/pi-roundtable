// The owner app over a real host: boots it with the app's plugin, a runtime that follows scripts, and sockets that talk to it. The suites that drive the app's frames share it.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActorFacts, TurnRequest, TurnResult } from "pi-roundtable";
import { type TestHost, testHost } from "pi-roundtable/testing";
import type { ServerFrame } from "../api-types.ts";
import { APP_PROTOCOL } from "../app/protocol.ts";
import { admitAs, refuse, type Verdict } from "../verifier.ts";
import { webConsole } from "../web-plugin.ts";

export const ORIGIN = "https://app.example.test";
export const ADA_DISCORD = "100000000000000001";
export const MEL_DISCORD = "200000000000000002";
// Not e-host's Sam: a suite that ran first may have linked that id to a principal of its own in the shared database.
export const BOB_DISCORD = "300000000000000031";
/** A guild of this suite's own, so the agents other suites stored in the shared database are not on this team. */
export const GUILD = "900000000000000731";
export const ENTRY_CHANNEL = "900000000000000732";
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

/** The sockets' verifier: the header `x-actor` names who the proxy vouches for. */
export function verifier(request: Request): Verdict {
	const who = request.headers.get("x-actor");
	if (who === "owner") {
		const expire = Number(request.headers.get("x-expire-ms"));
		return admitAs(ADA, expire > 0 ? new Date(Date.now() + expire) : undefined);
	}
	if (who === "member") return admitAs(MEL);
	if (who === "owner2") return admitAs(BOB);
	return refuse("no proxy assertion");
}

export const BOB: ActorFacts = {
	provider: "discord",
	subject: BOB_DISCORD,
	name: "Bob",
};

export const PNG = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);

/** What a scripted turn does; absent, the turn answers by echoing the text. */
export type Script = (
	request: TurnRequest,
	signal: AbortSignal,
) => Promise<TurnResult>;

export interface Booted {
	host: TestHost;
	socket: string;
	dataDir: string;
	seen: TurnRequest[];
	scripts: Map<string, Script>;
	stops: string[];
	stop(): Promise<void>;
}

/** Boots the host over the test database with the app's plugin and a runtime that follows scripts. */
export async function boot(options: {
	auth: "verifier" | "none";
	dataDir?: string;
	graceSeconds?: number;
	uploadMaxBytes?: number;
	/** A team without Discord channels, whose agents live in the app's rooms. */
	local?: boolean;
	/** A second owner, so the agent rooms have two readers. */
	secondOwner?: boolean;
}): Promise<Booted> {
	const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "app-socket-"));
	const socket = join(dataDir, "public.sock");
	const assets = mkdtempSync(join(tmpdir(), "app-socket-page-"));
	writeFileSync(join(assets, "index.html"), "<html>app</html>");
	const seen: TurnRequest[] = [];
	const scripts = new Map<string, Script>();
	const running = new Map<string, AbortController>();
	const stops: string[] = [];
	const runtime = {
		runTurn: async (request: TurnRequest): Promise<TurnResult> => {
			seen.push(request);
			const controller = new AbortController();
			running.set(request.channel, controller);
			try {
				const script = [...scripts].find(([marker]) =>
					request.text.includes(marker),
				)?.[1];
				if (script) return await script(request, controller.signal);
				return { ok: true, text: `echo ${request.text}` };
			} finally {
				running.delete(request.channel);
			}
		},
		// A message that says so is taken into the running turn; the others wait for their own.
		steer: async (_channel: string, text: string) => text.includes("steer-me"),
		stop: (channel: string) => {
			stops.push(channel);
			const controller = running.get(channel as never);
			controller?.abort();
			return controller !== undefined;
		},
		startFresh: async () => undefined,
		deleteConversation: async () => undefined,
		pendingConfirmation: () => undefined,
		heldActions: async () => undefined,
		recentTranscript: async () => [],
	};
	const host = await testHost({
		...(options.local ? { discord: false as const } : {}),
		config: {
			dataDir,
			...(options.local
				? {}
				: {
						discord: {
							token: "token",
							guild: GUILD,
							entryChannel: ENTRY_CHANNEL,
						},
					}),
			http: { publicUrl: "https://bot.example.com", socketPath: socket },
			access: {
				owners: [
					{
						name: "Ada",
						principal: ADA_DISCORD,
						identities: [`discord:${ADA_DISCORD}`],
					},
					...(options.secondOwner
						? [
								{
									name: "Bob",
									principal: BOB_DISCORD,
									identities: [`discord:${BOB_DISCORD}`],
								},
							]
						: []),
				],
				members: { identities: [`discord:${MEL_DISCORD}`] },
			},
			agents: [
				{
					name: "guide",
					displayName: "Guide",
					prompt: "You guide.",
					avatarPrompt: "A guide",
					...(options.local ? {} : { channelId: ENTRY_CHANNEL }),
				},
				{
					name: "scout",
					displayName: "Scout",
					prompt: "You scout.",
					avatarPrompt: "A scout",
				},
			],
		},
		runtime,
		plugins: [
			webConsole({
				...(options.auth === "none"
					? { auth: { mode: "none" as const } }
					: { verifier }),
				origin: ORIGIN,
				dataDir,
				assetDir: assets,
				cardGraceSeconds: options.graceSeconds ?? 120,
				...(options.uploadMaxBytes
					? { uploadMaxBytes: options.uploadMaxBytes }
					: {}),
				panes: ["rooms", "schedules", "overview"],
			}),
		],
	});
	return {
		host,
		socket,
		dataDir,
		seen,
		scripts,
		stops,
		stop: () => host.stop(),
	};
}

/** One app WebSocket and the frames it received. */
export class Client {
	readonly frames: ServerFrame[] = [];
	/** Frames before this index have been passed over by a `take`. */
	#cursor = 0;
	readonly #ws: WebSocket;
	closed: { code: number } | undefined;

	private constructor(ws: WebSocket) {
		this.#ws = ws;
		ws.onmessage = (event) =>
			this.frames.push(JSON.parse(String(event.data)) as ServerFrame);
		ws.onclose = (event) => {
			this.closed = { code: event.code };
		};
	}

	/** Opens a socket, or undefined when the upgrade is refused. */
	static async open(
		boot: Booted,
		headers: Record<string, string>,
		origin: string = ORIGIN,
	): Promise<Client | undefined> {
		const ws = new WebSocket(`ws+unix://${boot.socket}:/console/api/socket`, {
			protocols: [APP_PROTOCOL],
			headers: { origin, ...headers },
		} as never);
		const opened = await new Promise<boolean>((resolve) => {
			ws.onopen = () => resolve(true);
			ws.onerror = () => resolve(false);
			ws.onclose = () => resolve(false);
		});
		return opened ? new Client(ws) : undefined;
	}

	send(frame: object): void {
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

export const agentReply = (agent: string) => (frame: ServerFrame) =>
	frame.type === "message" && frame.message.agent === agent;

/** Matches the `activity` frame of a room that has these fields. */
export const activity = (room: string, over: object) => (frame: ServerFrame) =>
	frame.type === "activity" &&
	frame.room === room &&
	Object.entries(over).every(
		([key, value]) => (frame as Record<string, unknown>)[key] === value,
	);

/** A request to the app's REST over the host's unix socket. */
export function rest(
	boot: Booted,
	path: string,
	init: RequestInit & { who?: string; origin?: string | null } = {},
): Promise<Response> {
	const { who = "owner", origin = ORIGIN, ...rest } = init;
	return fetch(`http://localhost/console/api/${path}`, {
		...rest,
		headers: {
			"x-actor": who,
			...(origin ? { origin } : {}),
			...(rest.body ? { "content-type": "application/json" } : {}),
			...(rest.headers as Record<string, string> | undefined),
		},
		unix: boot.socket,
	} as never);
}

export const GUIDE = "app:agent.guide";
export const SCOUT = "app:agent.scout";
