import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { ErrorBoundary } from "./components/boundary.tsx";
import { loadKit } from "./lib/kit.ts";
import { initTheme } from "./lib/theme.ts";

// The stored color scheme goes on before React draws, so the first paint is already the right one.
initTheme();
// The character kit is a chunk of its own; it starts loading now, beside the config and the room list.
loadKit().catch((failure: unknown) =>
	console.warn("the character kit failed to load", failure),
);
// Where view transitions are missing, a page change fades in by a stylesheet animation instead.
if (typeof document.startViewTransition !== "function")
	document.documentElement.classList.add("no-vt");

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root");
createRoot(root).render(
	<StrictMode>
		<ErrorBoundary>
			<App />
		</ErrorBoundary>
	</StrictMode>,
);

// The worker makes the console installable; the page works without one, so a failure only logs.
if ("serviceWorker" in navigator) {
	const base = new URL("./", document.baseURI);
	navigator.serviceWorker
		.register(new URL("sw.js", base), { scope: base.href })
		.catch((error: unknown) => console.warn("service worker failed", error));
	// A tap on a notification while the app is open: the worker asks the page to go there.
	navigator.serviceWorker.addEventListener("message", (event) => {
		const data: unknown = event.data;
		if (
			typeof data !== "object" ||
			data === null ||
			(data as { type?: unknown }).type !== "roundtable:open"
		)
			return;
		const url = URL.parse(String((data as { url?: unknown }).url), base);
		if (url && url.origin === window.location.origin) {
			if (
				url.pathname === window.location.pathname &&
				url.search === window.location.search
			)
				window.location.hash = url.hash;
			else window.location.assign(url);
		}
	});
}
