import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { initTheme } from "./lib/theme.ts";

// The stored color scheme goes on before React draws, so the first paint is already the right one.
initTheme();
// Where view transitions are missing, a page change fades in by a stylesheet animation instead.
if (typeof document.startViewTransition !== "function")
	document.documentElement.classList.add("no-vt");

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root");
createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);

// The worker makes the console installable; the page works without one, so a failure only logs.
if ("serviceWorker" in navigator) {
	const base = new URL("./", document.baseURI);
	navigator.serviceWorker
		.register(new URL("sw.js", base), { scope: base.href })
		.catch((error: unknown) => console.warn("service worker failed", error));
}
