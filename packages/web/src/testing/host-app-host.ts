import { afterAll, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ActorFacts,
	IDENTITY,
	type TurnRequest,
	type TurnResult,
} from "pi-roundtable";
import { type TestHost, testHost } from "pi-roundtable/testing";
import type { ServerFrame } from "../api-types.ts";
import { APP_PROTOCOL } from "../app/protocol.ts";
import { admitAs, refuse, type Verdict } from "../verifier.ts";
import type { WebApp } from "../web-app.ts";
import { webConsole } from "../web-plugin.ts";

import {
	GUIDE,
	type Inbox,
	inbox,
	inboxPlugin,
	READ_WRITE,
	ROOM_A_ID,
	ROOM_B_ID,
} from "./host-app-inbox.ts";

export {
	AGENT_ROOM,
	GUIDE,
	type Inbox,
	inbox,
	PNG,
	READ_WRITE,
	ROOM_A,
	ROOM_A_ID,
	ROOM_B,
	ROOM_B_ID,
	RUN,
} from "./host-app-inbox.ts";
export const ORIGIN = "https://app.example.test";
export const FACTS = {
	ada: { provider: "discord", subject: "100000000000000011", name: "Ada" },
	mel: {
		provider: "discord",
		subject: "200000000000000012",
		name: "Mel",
		roles: ["web:role:pm"],
	},
	kim: { provider: "discord", subject: "300000000000000013", name: "Kim" },
	zed: { provider: "discord", subject: "400000000000000014", name: "Zed" },
} satisfies Record<string, ActorFacts>;
export type Who = keyof typeof FACTS;

/** The sockets' verifier: the header `x-actor` names who the proxy vouches for. */
export function verifier(request: Request): Verdict {
	const who = request.headers.get("x-actor") as Who | null;
	return who && FACTS[who] ? admitAs(FACTS[who]) : refuse("no proxy assertion");
}

/** Room ids of this run, so the rooms the shared database keeps from earlier runs are not these. */
export interface Booted {
	host: TestHost;
	socket: string;
	dataDir: string;
	state: Inbox;
	principals: Record<Who, string>;
	stop(): Promise<void>;
}

export async function boot(): Promise<Booted> {
	const dataDir = mkdtempSync(join(tmpdir(), "host-app-"));
	const socket = join(dataDir, "public.sock");
	const assets = mkdtempSync(join(tmpdir(), "host-app-page-"));
	writeFileSync(join(assets, "index.html"), "<html>app</html>");
	const state = inbox();
	const runtime = {
		runTurn: async (request: TurnRequest): Promise<TurnResult> => {
			await state.hold;
			return { ok: true, text: `echo ${request.text}` };
		},
		steer: async () => false,
		stop: () => false,
		startFresh: async () => undefined,
		deleteConversation: async () => undefined,
		pendingConfirmation: () => undefined,
		heldActions: async () => undefined,
		recentTranscript: async () => [],
	};
	const host = await testHost({
		discord: false as const,
		config: {
			dataDir,
			http: { publicUrl: "https://bot.example.com", socketPath: socket },
			access: {
				owners: [
					{
						name: "Ada",
						principal: FACTS.ada.subject,
						identities: [`discord:${FACTS.ada.subject}`],
					},
				],
				members: {
					identities: [FACTS.mel, FACTS.kim, FACTS.zed].map(
						(facts) => `discord:${facts.subject}`,
					),
				},
			},
			agents: [
				{
					name: GUIDE,
					displayName: "Guide",
					prompt: "You guide.",
					avatarPrompt: "A guide",
				},
			],
		},
		runtime,
		plugins: [
			webConsole({
				verifier,
				admission: "access",
				origin: ORIGIN,
				dataDir,
				assetDir: assets,
				cardGraceSeconds: 120,
				// The round table is named for the members too: it seats only what they may list.
				panes: { owner: ["rooms", "table"], member: ["rooms", "table"] },
			}),
			inboxPlugin(state),
		],
	});
	const identity = host.context.services.get(IDENTITY);
	const principals = {} as Record<Who, string>;
	for (const who of Object.keys(FACTS) as Who[]) {
		const speaker = await identity.resolve(FACTS[who] as ActorFacts);
		if (!speaker) throw new Error(`${who} resolves to no one`);
		principals[who] = speaker.principalId;
	}
	return {
		host,
		socket,
		dataDir,
		state,
		principals,
		stop: () => host.stop(),
	};
}

/** One app WebSocket and the frames it received. */
export class Client {
	readonly frames: ServerFrame[] = [];
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

	static async open(boot: Booted, who: Who): Promise<Client> {
		const ws = new WebSocket(`ws+unix://${boot.socket}:/console/api/socket`, {
			protocols: [APP_PROTOCOL],
			headers: { origin: ORIGIN, "x-actor": who },
		} as never);
		const opened = await new Promise<boolean>((resolve) => {
			ws.onopen = () => resolve(true);
			ws.onerror = () => resolve(false);
			ws.onclose = () => resolve(false);
		});
		if (!opened) throw new Error(`${who} was refused`);
		const client = new Client(ws);
		await client.take((frame) => frame.type === "ready");
		return client;
	}

	send(frame: object): void {
		this.#ws.send(JSON.stringify(frame));
	}

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

	/** Whether a matching frame shows up within `ms` (it is not taken). */
	async sees(
		match: (frame: ServerFrame) => boolean,
		ms = 250,
	): Promise<boolean> {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			if (this.frames.some((f, index) => index >= this.#cursor && match(f)))
				return true;
			await Bun.sleep(10);
		}
		return false;
	}

	/** Passes over everything received so far. */
	skip(): void {
		this.#cursor = this.frames.length;
	}

	close(): void {
		this.#ws.close();
	}
}

export const ofType =
	<K extends ServerFrame["type"]>(type: K) =>
	(frame: ServerFrame): frame is Extract<ServerFrame, { type: K }> =>
		frame.type === type;

export function rest(
	boot: Booted,
	path: string,
	init: RequestInit & { who?: Who } = {},
): Promise<Response> {
	const { who = "ada", ...more } = init;
	return fetch(`http://localhost/console/api/${path}`, {
		...more,
		headers: {
			"x-actor": who,
			origin: ORIGIN,
			...(typeof more.body === "string"
				? { "content-type": "application/json" }
				: {}),
			...(more.headers as Record<string, string> | undefined),
		},
		unix: boot.socket,
	} as never);
}

export const post = (boot: Booted, path: string, body: object, who: Who) =>
	rest(boot, path, { method: "POST", body: JSON.stringify(body), who });

export let app: Booted;
export let web: WebApp;

/** Boots the host once for the suite it is called in, with the grants the tests read, and stops it after. */
export function hostAppSuite(): void {
	beforeAll(async () => {
		app = await boot();
		web = app.state.web as WebApp;
		const { principals, state } = app;
		state.grants.set(
			principals.ada,
			new Map([
				[ROOM_A_ID, READ_WRITE],
				[ROOM_B_ID, READ_WRITE],
			]),
		);
		state.grants.set(principals.mel, new Map([[ROOM_A_ID, READ_WRITE]]));
		state.grants.set(
			principals.kim,
			new Map([[ROOM_A_ID, { read: true, send: ["note"], act: false }]]),
		);
	}, 30_000);
	afterAll(async () => {
		await app.stop();
	});
}

export const external = (text: string, over: object = {}) => ({
	author: { kind: "external" as const, label: "Customer", name: "Pat" },
	text,
	...over,
});
