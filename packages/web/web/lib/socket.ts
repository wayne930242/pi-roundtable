import type { ClientFrame, ServerFrame } from "../../src/api-types.ts";
import { APP_CLOSE_EXPIRED, APP_CLOSE_FORBIDDEN } from "../../src/api-types.ts";
import { store } from "./app-store.ts";
import type { PendingSend } from "./rooms.ts";

/** The longest the wait before a reconnect grows to. */
const MAX_BACKOFF_MS = 15_000;
/** Streamed text reaches the state at most this long after it arrived, even where frames do not paint. */
const FLUSH_FALLBACK_MS = 120;

const isServerFrame = (value: unknown): value is ServerFrame =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as { type?: unknown }).type === "string";

/**
 * The page's one WebSocket to the owner app: it reconnects with backoff, tells the server what
 * is in view, and feeds every frame to the store. Streamed text is gathered and handed over once
 * per animation frame, so a fast stream costs one render a frame, not one a word.
 */
export class AppConnection {
	readonly #url: URL;
	readonly #protocol: string;
	#socket: WebSocket | undefined;
	#attempt = 0;
	#retry: ReturnType<typeof setTimeout> | undefined;
	#stopped = false;
	#expired = false;
	#focus: string | undefined;
	/** Text deltas of one room not yet in the store. */
	#text: { room: string; delta: string } | undefined;
	#flushing: number | undefined;
	#fallback: ReturnType<typeof setTimeout> | undefined;

	constructor(protocol: string, base: string = document.baseURI) {
		const url = new URL("api/socket", base);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		this.#url = url;
		this.#protocol = protocol;
	}

	start(): void {
		this.#stopped = false;
		this.#connect();
		document.addEventListener("visibilitychange", this.#visibility);
		addEventListener("online", this.#wake);
		addEventListener("pageshow", this.#wake);
	}

	stop(): void {
		this.#stopped = true;
		clearTimeout(this.#retry);
		document.removeEventListener("visibilitychange", this.#visibility);
		removeEventListener("online", this.#wake);
		removeEventListener("pageshow", this.#wake);
		this.#socket?.close(1000, "page closed");
	}

	get open(): boolean {
		return this.#socket?.readyState === WebSocket.OPEN;
	}

	/** Sends a frame; false when the socket is not open, in which case nothing was sent. */
	send(frame: ClientFrame): boolean {
		if (!this.open) return false;
		this.#socket?.send(JSON.stringify(frame));
		return true;
	}

	/** Tells the server which room the page shows, whose progress then streams to it. */
	focus(room: string | undefined): void {
		this.#focus = room;
		store.dispatch({ type: "focused", room });
		this.send({ type: "focus", ...(room ? { room } : {}) });
	}

	/** Sends a message of the person; it waits in the room as pending until the server answers. */
	say(room: string, text: string, files: PendingSend["files"] = []): void {
		const id = crypto.randomUUID();
		store.dispatch({ type: "queued", id, room, text, files });
		const sent = this.send({
			type: "send",
			id,
			room,
			text,
			...(files.length ? { uploads: files.map((file) => file.id) } : {}),
		});
		if (!sent) store.dispatch({ type: "refused", id, code: "not_accepted" });
	}

	/** Sends a message again that failed, as a new one. */
	retry(pending: PendingSend): void {
		store.dispatch({ type: "pending_dropped", id: pending.id });
		this.say(pending.room, pending.text, pending.files);
	}

	readonly #visibility = () => {
		this.send({
			type: "visibility",
			visible: document.visibilityState === "visible",
		});
		if (document.visibilityState === "visible") this.#wake();
	};

	/** The page came back or the network did: try at once instead of waiting out the backoff. */
	readonly #wake = () => {
		if (this.#stopped || this.#socket) return;
		clearTimeout(this.#retry);
		this.#connect();
	};

	#connect(): void {
		if (this.#stopped || this.#socket) return;
		store.dispatch({
			type: "connection",
			status: this.#attempt === 0 ? "connecting" : "reconnecting",
		});
		let opened = false;
		const socket = new WebSocket(this.#url, [this.#protocol]);
		this.#socket = socket;
		socket.onopen = () => {
			opened = true;
			this.#attempt = 0;
			this.#expired = false;
		};
		socket.onmessage = (event) => this.#onMessage(String(event.data));
		socket.onclose = (event) => {
			this.#socket = undefined;
			this.#flush();
			if (this.#stopped) return;
			if (event.code === APP_CLOSE_FORBIDDEN) {
				store.dispatch({ type: "forbidden" });
				return;
			}
			if (event.code === APP_CLOSE_EXPIRED) this.#expired = true;
			// A reconnect refused right after the credential lapsed means signing in again, which a
			// reload of the page does: the proxy or the login page takes over.
			if (!opened && this.#expired) {
				location.reload();
				return;
			}
			this.#attempt += 1;
			store.dispatch({ type: "connection", status: "reconnecting" });
			const wait = this.#expired
				? 0
				: Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(this.#attempt, 6));
			this.#retry = setTimeout(
				() => this.#connect(),
				wait * (0.75 + Math.random() * 0.5),
			);
		};
	}

	#onMessage(raw: string): void {
		let frame: unknown;
		try {
			frame = JSON.parse(raw);
		} catch {
			return;
		}
		if (!isServerFrame(frame)) return;
		if (frame.type === "progress" && frame.event.type === "text") {
			this.#queueText(frame.room, frame.event.delta);
			return;
		}
		// Anything else keeps its place after the text that came before it.
		this.#flush();
		store.dispatch(frame);
		if (frame.type === "ready") {
			this.send({
				type: "hello",
				visible: document.visibilityState === "visible",
				...(this.#focus ? { focus: this.#focus } : {}),
			});
		}
	}

	#queueText(room: string, delta: string): void {
		if (this.#text && this.#text.room !== room) this.#flush();
		this.#text = { room, delta: (this.#text?.delta ?? "") + delta };
		if (this.#flushing === undefined)
			this.#flushing = requestAnimationFrame(() => this.#flush());
		// A hidden page paints no frames, and its text would pile up.
		this.#fallback ??= setTimeout(() => this.#flush(), FLUSH_FALLBACK_MS);
	}

	#flush(): void {
		if (this.#flushing !== undefined) cancelAnimationFrame(this.#flushing);
		clearTimeout(this.#fallback);
		this.#flushing = undefined;
		this.#fallback = undefined;
		const text = this.#text;
		this.#text = undefined;
		if (text)
			store.dispatch({
				type: "progress",
				room: text.room,
				event: { type: "text", delta: text.delta },
			});
	}
}

let connection: AppConnection | undefined;

/** Opens the page's connection, once. */
export function startConnection(protocol: string): AppConnection {
	if (!connection) {
		connection = new AppConnection(protocol);
		connection.start();
	}
	return connection;
}

/** The connection the page opened; throws before `startConnection`. */
export function useConnection(): AppConnection {
	if (!connection) throw new Error("the owner app is not connected");
	return connection;
}
