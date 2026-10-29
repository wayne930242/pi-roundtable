// The service worker: it makes the console installable and keeps the shell available offline.
// `bun run build` compiles this file to dist/sw.js and defines the two constants below.
// Event handlers sit side by side at the bottom; a new capability adds its own
// `scope.addEventListener(...)` there and leaves the fetch handler alone.

declare const __PRECACHE__: readonly string[];
declare const __VERSION__: string;

interface WorkerEvent extends Event {
	waitUntil(work: Promise<unknown>): void;
}
interface WorkerFetchEvent extends WorkerEvent {
	request: Request;
	respondWith(response: Promise<Response> | Response): void;
}
interface WorkerPushEvent extends WorkerEvent {
	data: { json(): unknown } | null;
}
interface WorkerNotification {
	close(): void;
	data: unknown;
}
interface WorkerNotificationEvent extends WorkerEvent {
	notification: WorkerNotification;
}
interface WorkerWindow {
	url: string;
	focus(): Promise<unknown>;
	postMessage(message: unknown): void;
}
interface WorkerScope {
	registration: {
		scope: string;
		showNotification(title: string, options: object): Promise<void>;
		getNotifications(options?: { tag?: string }): Promise<WorkerNotification[]>;
	};
	navigator: {
		setAppBadge?(count: number): Promise<void>;
		clearAppBadge?(): Promise<void>;
	};
	clients: {
		claim(): Promise<void>;
		matchAll(options: object): Promise<WorkerWindow[]>;
		openWindow(url: string): Promise<unknown>;
	};
	skipWaiting(): Promise<void>;
	addEventListener(type: string, listener: (event: never) => void): void;
}

// SAFETY: this file only ever runs as a service worker, whose global is the WorkerScope above.
const scope = self as unknown as WorkerScope;
const base = new URL(scope.registration.scope);
const cacheName = `roundtable-web-${__VERSION__}`;
const shell = new URL("index.html", base).href;
const precached = new Set(__PRECACHE__.map((file) => new URL(file, base).href));
// Not precached (see scripts/build-page.ts): cached the first time a round table opens.
const LAZY = /\/chunk-table3d-[a-z0-9]+\.js$/;
// The files pane's editor and the languages it highlights, cached the first time a file opens. The
// code they share may be hoisted into a chunk the bundler names `index`; that one is kept out of the
// precache by what it carries (build-page.ts) and left to the browser's own cache, as hashed files
// are immutable.
const LAZY_EDITOR = /\/chunk-(?:codeeditor|lang-[a-z]+)-[a-z0-9]+\.js$/;
// The API, the login flow and the private files change with the session; none is ever cached.
// `api/` covers the workspace files (`api/workspace/…`), which a file's text and bytes are never kept from.
const BYPASS = ["api/", "auth/", "login", "files/", "avatars/"];

const bypassed = (url: URL): boolean => {
	const rest = url.pathname.slice(base.pathname.length);
	return BYPASS.some((prefix) => rest.startsWith(prefix));
};

async function shellFirst(request: Request): Promise<Response> {
	const cache = await caches.open(cacheName);
	try {
		// A redirect (a proxy's login) comes back as it is, never replaced by the cached shell.
		const response = await fetch(request);
		if (response.ok && new URL(request.url).href === base.href)
			await cache.put(shell, response.clone());
		return response;
	} catch {
		const cached = await cache.match(shell);
		if (cached) return cached;
		throw new Error("offline and the shell is not cached");
	}
}

async function asset(request: Request): Promise<Response> {
	const cache = await caches.open(cacheName);
	const cached = await cache.match(request);
	if (cached) return cached;
	const response = await fetch(request);
	if (response.ok) await cache.put(request, response.clone());
	return response;
}

/** What a push carries; every field is checked before it is shown. */
interface PushMessage {
	title?: unknown;
	body?: unknown;
	tag?: unknown;
	url?: unknown;
	kind?: unknown;
	badge?: unknown;
	urgency?: unknown;
}

const text = (value: unknown, max: number): string | undefined =>
	typeof value === "string" && value ? value.slice(0, max) : undefined;

/** A link the notification opens: a path under the app's scope on this origin, else the app itself. */
function openTarget(value: unknown): string {
	if (typeof value !== "string") return base.href;
	const url = URL.parse(value, base);
	return url &&
		url.origin === base.origin &&
		url.pathname.startsWith(base.pathname)
		? url.href
		: base.href;
}

/**
 * Notices and test pushes tell the app they arrived, and when they are opened, so it knows the
 * person's devices work. The agent rooms' own pushes (a card, a reply) post nothing.
 */
const RECEIPTED: ReadonlySet<string> = new Set(["notice", "test"]);

async function receipt(
	data: { tag?: string; kind?: string } | null,
	event: "received" | "opened",
): Promise<void> {
	if (!data?.tag || !data.kind || !RECEIPTED.has(data.kind)) return;
	try {
		// The app's session cookie goes with it; the worker is on the app's origin.
		await fetch(new URL("api/push/receipts", base), {
			method: "POST",
			credentials: "include",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ tag: data.tag, event }),
		});
	} catch {
		// Offline, or signed out: the receipt is lost, and the next push tries again.
	}
}

/** The app icon's count, where the device lets a worker set it; best effort. */
async function setBadge(count: unknown): Promise<void> {
	if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
		return;
	try {
		if (count > 0) await scope.navigator.setAppBadge?.(count);
		else await scope.navigator.clearAppBadge?.();
	} catch {
		// A device without badges ignores it.
	}
}

// A browser that lets the page subscribe only with `userVisibleOnly` expects a notification for
// every push, so a message that cannot be read still shows a generic one. A `clear` push, which
// only closes a notification the app took back and sets the count, is the one that shows nothing.
async function showPush(event: WorkerPushEvent): Promise<void> {
	let message: PushMessage = {};
	try {
		const data = event.data?.json();
		if (typeof data === "object" && data !== null)
			message = data as PushMessage;
	} catch {
		// An unreadable payload shows the generic notification.
	}
	const tag = text(message.tag, 200);
	const kind = text(message.kind, 16);
	await setBadge(message.badge);
	if (kind === "clear") {
		if (tag)
			for (const shown of await scope.registration.getNotifications({ tag }))
				shown.close();
		return;
	}
	await scope.registration.showNotification(
		text(message.title, 120) ?? "Roundtable",
		{
			body: text(message.body, 240),
			icon: new URL("icons/192.png", base).href,
			badge: new URL("icons/badge-96.png", base).href,
			...(tag ? { tag, renotify: true } : {}),
			// An urgent notice stays until the person deals with it.
			...(message.urgency === "high" ? { requireInteraction: true } : {}),
			data: {
				url: openTarget(message.url),
				...(tag ? { tag } : {}),
				...(kind ? { kind } : {}),
			},
		},
	);
	await receipt(
		{ ...(tag ? { tag } : {}), ...(kind ? { kind } : {}) },
		"received",
	);
}

/**
 * A tap opens exactly what the notification is about. With the app open in a window, that window
 * is brought forward and asked to go there in place; with no window, a new one opens at that
 * address, and a signed-out person meets sign-in first and lands there after it.
 */
async function openFromNotification(
	event: WorkerNotificationEvent,
): Promise<void> {
	event.notification.close();
	const data = event.notification.data as {
		url?: unknown;
		tag?: unknown;
		kind?: unknown;
	} | null;
	const url = openTarget(data?.url);
	const tag = text(data?.tag, 200);
	const kind = text(data?.kind, 16);
	const told = receipt(
		{ ...(tag ? { tag } : {}), ...(kind ? { kind } : {}) },
		"opened",
	);
	const windows = await scope.clients.matchAll({
		type: "window",
		includeUncontrolled: true,
	});
	const open = windows.find((window) => window.url.startsWith(base.href));
	if (open) {
		await open.focus();
		open.postMessage({ type: "roundtable:open", url });
	} else await scope.clients.openWindow(url);
	await told;
}

scope.addEventListener("install", (event: WorkerEvent) => {
	event.waitUntil(
		caches
			.open(cacheName)
			.then((cache) => cache.addAll([...precached]))
			.then(() => scope.skipWaiting()),
	);
});

scope.addEventListener("activate", (event: WorkerEvent) => {
	event.waitUntil(
		caches
			.keys()
			.then((names) =>
				Promise.all(
					names
						.filter(
							(name) =>
								name.startsWith("roundtable-web-") && name !== cacheName,
						)
						.map((name) => caches.delete(name)),
				),
			)
			.then(() => scope.clients.claim()),
	);
});

scope.addEventListener("fetch", (event: WorkerFetchEvent) => {
	const { request } = event;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
		return;
	if (bypassed(url)) return;
	if (request.mode === "navigate") event.respondWith(shellFirst(request));
	else if (
		precached.has(url.origin + url.pathname) ||
		LAZY.test(url.pathname) ||
		LAZY_EDITOR.test(url.pathname)
	)
		event.respondWith(asset(request));
});

scope.addEventListener("push", (event: WorkerPushEvent) => {
	event.waitUntil(showPush(event));
});

scope.addEventListener(
	"notificationclick",
	(event: WorkerNotificationEvent) => {
		event.waitUntil(openFromNotification(event));
	},
);
