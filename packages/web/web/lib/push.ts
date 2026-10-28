import { api } from "./api.ts";

/** Whether this device can get push, and whether it does now. */
export type PushState = "unsupported" | "blocked" | "off" | "on";

const pushSupported = (): boolean =>
	typeof navigator !== "undefined" &&
	"serviceWorker" in navigator &&
	typeof window !== "undefined" &&
	"PushManager" in window &&
	"Notification" in window;

/** The worker the page registered; push is subscribed through it. */
const registration = (): Promise<ServiceWorkerRegistration> =>
	navigator.serviceWorker.ready;

/** The id the server lists this device under: the SHA-256 of its endpoint, hex. */
async function idOf(endpoint: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(endpoint),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

const keyBytes = (key: string): Uint8Array<ArrayBuffer> =>
	Uint8Array.from(atob(key.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
		c.charCodeAt(0),
	);

const sameKey = (
	have: ArrayBuffer | null | undefined,
	want: Uint8Array,
): boolean => {
	if (!have || have.byteLength !== want.byteLength) return false;
	const a = new Uint8Array(have);
	return a.every((byte, index) => byte === want[index]);
};

/** A short name for this device in the list, such as "Chrome on macOS". */
function deviceLabel(): string {
	const agent = navigator.userAgent;
	const browser = /Edg\//.test(agent)
		? "Edge"
		: /Firefox\//.test(agent)
			? "Firefox"
			: /Chrome\//.test(agent)
				? "Chrome"
				: /Safari\//.test(agent)
					? "Safari"
					: "Browser";
	const system = /iPhone|iPad/.test(agent)
		? "iOS"
		: /Android/.test(agent)
			? "Android"
			: /Mac OS X/.test(agent)
				? "macOS"
				: /Windows/.test(agent)
					? "Windows"
					: /Linux/.test(agent)
						? "Linux"
						: "";
	return system ? `${browser} on ${system}` : browser;
}

/** How push stands on this device now. */
export async function pushState(): Promise<PushState> {
	if (!pushSupported()) return "unsupported";
	if (Notification.permission === "denied") return "blocked";
	const found = await (await registration()).pushManager.getSubscription();
	return found && Notification.permission === "granted" ? "on" : "off";
}

/** The list id of this device's subscription, if it has one. */
export async function thisDevice(): Promise<string | undefined> {
	if (!pushSupported()) return undefined;
	const found = await (await registration()).pushManager.getSubscription();
	return found ? idOf(found.endpoint) : undefined;
}

/** Asks for permission, subscribes, and tells the server. Throws the reason it could not. */
export async function enablePush(): Promise<void> {
	const permission = await Notification.requestPermission();
	if (permission !== "granted") throw new Error("permission");
	const { key } = await api.pushKey();
	const wanted = keyBytes(key);
	const { pushManager } = await registration();
	let found = await pushManager.getSubscription();
	// A subscription made against another server key can never be pushed to; start over.
	if (found && !sameKey(found.options.applicationServerKey, wanted)) {
		await found.unsubscribe();
		found = null;
	}
	const subscription =
		found ??
		(await pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: wanted,
		}));
	const json = subscription.toJSON();
	if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth)
		throw new Error("subscription");
	await api.addPushDevice({
		endpoint: json.endpoint,
		keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
		label: deviceLabel(),
	});
}

/** Unsubscribes this device in the browser and on the server. */
export async function disablePush(): Promise<void> {
	if (!pushSupported()) return;
	const found = await (await registration()).pushManager.getSubscription();
	if (!found) return;
	await api.removePushEndpoint(found.endpoint);
	await found.unsubscribe();
}
