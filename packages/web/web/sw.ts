// The service worker: it makes the console installable and keeps the shell available offline.
// `bun run build` compiles this file to dist/sw.js and defines the two constants below.
// Event handlers sit side by side at the bottom; a new capability, such as push, adds its own
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
interface WorkerScope {
	registration: { scope: string };
	clients: { claim(): Promise<void> };
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
