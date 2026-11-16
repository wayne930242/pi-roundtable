import { createCipheriv, randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { Networking, VoiceWebSocket } from "@discordjs/voice";

// A voice server on this machine, for the tests that run @discordjs/voice itself: the voice
// gateway's socket and the media socket, both on the loopback interface. The library dials it as
// it dials Discord's, so the handshake, the Resume and the receiver under test are the ones that
// ship. Nothing leaves the machine.

/** The transport encryption the server offers, one of the two the library knows. */
const MODE = "aead_aes256_gcm_rtpsize";

/** The library's own way to dial a voice gateway, which is private in its types. */
interface Dialler {
	createWebSocket(endpoint: string, lastSequence?: number): VoiceWebSocket;
}
/** What a networking hands its voice socket, as `createWebSocket` wires it in @discordjs/voice 0.19.2. */
type Wiring = Record<
	| "onChildError"
	| "onWsOpen"
	| "onWsPacket"
	| "onWsBinary"
	| "onWsClose"
	| "onWsDebug",
	(...given: unknown[]) => void
>;
// SAFETY: the prototype has the method; only its type hides it.
const dialler = Networking.prototype as unknown as Dialler;
const dialDiscord = dialler.createWebSocket;
/** The endpoints of the servers that are up. */
const local = new Set<string>();

/** The library dials `wss://`, and a server on this machine speaks `ws://`: its endpoints, and no other, are dialled so. */
function dial(
	this: Dialler & Wiring,
	endpoint: string,
	lastSequence?: number,
): VoiceWebSocket {
	if (!local.has(endpoint))
		return dialDiscord.call(this, endpoint, lastSequence);
	const socket = new VoiceWebSocket(`ws://${endpoint}?v=8`, false);
	if (lastSequence !== undefined) socket.sequence = lastSequence;
	socket.on("error", this.onChildError);
	socket.once("open", this.onWsOpen);
	socket.on("packet", this.onWsPacket);
	socket.on("binary", this.onWsBinary);
	socket.once("close", this.onWsClose);
	socket.on("debug", this.onWsDebug);
	return socket;
}

export interface LocalVoiceServer {
	/** Where the bot is told to connect: `host:port`, as a voice server update names it. */
	readonly endpoint: string;
	/** How often the bot identified (each time over a new media socket), resumed its session, and was discovered on a media socket. */
	readonly counts: { identifies: number; resumes: number; discoveries: number };
	/**
	 * Whether audio reaches the bot. `stale`: it goes where the bot no longer listens until the bot
	 * is discovered on a new media socket, as after a network change. `dead`: it never arrives,
	 * whatever the bot does.
	 */
	media: "live" | "stale" | "dead";
	/** The voice socket says someone's speaking state, which names their SSRC: `flags` 0 for not speaking. */
	speaking(userId: string, flags?: number): void;
	/** One audio datagram of a speaker: an Opus packet under the transport encryption. */
	audio(userId: string, opus: Uint8Array): void;
	/** The voice socket drops with no close frame, which the library answers by resuming its session. */
	drop(): void;
	close(): Promise<void>;
}

/** Starts a voice server on the loopback interface; `close()` stops it. */
export async function localVoiceServer(): Promise<LocalVoiceServer> {
	const secretKey = randomBytes(32);
	const counts = { identifies: 0, resumes: 0, discoveries: 0 };
	/** Each speaker's SSRC, given when they are first named. */
	const ssrcs = new Map<string, number>();
	const ssrcOf = (userId: string): number => {
		const known = ssrcs.get(userId);
		if (known !== undefined) return known;
		const ssrc = 2_000 + ssrcs.size;
		ssrcs.set(userId, ssrc);
		return ssrc;
	};

	const media = createSocket("udp4");
	await new Promise<void>((bound) => media.bind(0, "127.0.0.1", bound));
	const mediaPort = media.address().port;
	/** Where the bot's media socket was last discovered. */
	let bot: { address: string; port: number } | undefined;
	let sequence = 0;
	let timestamp = 0;

	const sockets = new Set<Bun.ServerWebSocket<unknown>>();
	const say = (socket: Bun.ServerWebSocket<unknown>, op: number, d: unknown) =>
		socket.send(JSON.stringify({ op, d }));
	const gateway = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: (request, server) =>
			server.upgrade(request)
				? undefined
				: new Response("a voice gateway", { status: 400 }),
		websocket: {
			open(socket) {
				sockets.add(socket);
				// Hello; no heartbeat falls due within a test.
				say(socket, 8, { heartbeat_interval: 60_000 });
			},
			close(socket) {
				sockets.delete(socket);
			},
			message(socket, raw) {
				if (typeof raw !== "string") return;
				const packet = JSON.parse(raw) as { op: number; d: { t?: number } };
				if (packet.op === 0) {
					// Identify → Ready: the bot's SSRC and the media socket to discover itself on.
					counts.identifies++;
					say(socket, 2, {
						ssrc: 1_000,
						ip: "127.0.0.1",
						port: mediaPort,
						modes: [MODE],
					});
				} else if (packet.op === 1) {
					// Select Protocol → Session Description, with no end-to-end encryption.
					say(socket, 4, {
						mode: MODE,
						secret_key: [...secretKey],
						dave_protocol_version: 0,
					});
				} else if (packet.op === 3) say(socket, 6, { t: packet.d.t });
				else if (packet.op === 7) {
					// Resume → Resumed: the session goes on over the media socket it had.
					counts.resumes++;
					say(socket, 9, null);
				}
			},
		},
	});
	const endpoint = `127.0.0.1:${gateway.port}`;

	const server: LocalVoiceServer = {
		endpoint,
		counts,
		media: "live",
		speaking: (userId, flags = 1) => {
			for (const socket of sockets)
				say(socket, 5, {
					user_id: userId,
					ssrc: ssrcOf(userId),
					speaking: flags,
				});
		},
		audio: (userId, opus) => {
			if (server.media !== "live" || !bot) return;
			const header = Buffer.alloc(12);
			header[0] = 0x80;
			header[1] = 0x78;
			header.writeUInt16BE(sequence++ & 0xffff, 2);
			timestamp = (timestamp + 960) >>> 0;
			header.writeUInt32BE(timestamp, 4);
			header.writeUInt32BE(ssrcOf(userId), 8);
			const nonce = randomBytes(4);
			const cipher = createCipheriv(
				"aes-256-gcm",
				secretKey,
				Buffer.concat([nonce, Buffer.alloc(8)]),
			);
			cipher.setAAD(header);
			const sealed = Buffer.concat([cipher.update(opus), cipher.final()]);
			media.send(
				Buffer.concat([header, sealed, cipher.getAuthTag(), nonce]),
				bot.port,
				bot.address,
			);
		},
		drop: () => {
			for (const socket of sockets) socket.terminate();
		},
		close: async () => {
			local.delete(endpoint);
			if (local.size === 0) dialler.createWebSocket = dialDiscord;
			await gateway.stop(true);
			await new Promise<void>((closed) => media.close(() => closed()));
		},
	};

	media.on("message", (message, from) => {
		// IP discovery; the bot's keep-alives are not answered, as Discord's are not.
		if (message.length !== 74 || message.readUInt16BE(0) !== 1) return;
		counts.discoveries++;
		if (bot?.port !== from.port) {
			bot = { address: from.address, port: from.port };
			if (server.media === "stale") server.media = "live";
		}
		const answer = Buffer.alloc(74);
		answer.writeUInt16BE(2, 0);
		answer.writeUInt16BE(70, 2);
		answer.writeUInt32BE(message.readUInt32BE(4), 4);
		answer.write(from.address, 8, "utf8");
		answer.writeUInt16BE(from.port, 72);
		media.send(answer, from.port, from.address);
	});

	local.add(endpoint);
	dialler.createWebSocket = dial as Dialler["createWebSocket"];
	return server;
}
