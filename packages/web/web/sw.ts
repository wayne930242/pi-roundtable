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
interface WorkerNotificationEvent extends WorkerEvent {
	notification: { close(): void; data: unknown };
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
// The API, the login flow and the private files change with the session; none is ever cached.
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

// A browser that lets the page subscribe only with `userVisibleOnly` expects a notification for
// every push, so a message that cannot be read still shows a generic one.
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
	await scope.registration.showNotification(
		text(message.title, 120) ?? "Roundtable",
		{
			body: text(message.body, 240),
			icon: new URL("icons/192.png", base).href,
			badge: new URL("icons/badge-96.png", base).href,
			...(tag ? { tag, renotify: true } : {}),
			data: { url: openTarget(message.url) },
		},
	);
}

async function openFromNotification(
	event: WorkerNotificationEvent,
): Promise<void> {
	event.notification.close();
	const data = event.notification.data as { url?: unknown } | null;
	const url = openTarget(data?.url);
	const windows = await scope.clients.matchAll({
		type: "window",
		includeUncontrolled: true,
	});
	const open = windows.find((window) => window.url.startsWith(base.href));
	if (open) {
		await open.focus();
		open.postMessage({ type: "roundtable:open", url });
		return;
	}
	await scope.clients.openWindow(url);
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
	else if (precached.has(url.origin + url.pathname))
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
