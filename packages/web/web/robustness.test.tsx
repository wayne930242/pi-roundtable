import { afterEach, expect, test } from "bun:test";
import { partial } from "pi-roundtable/testing";
import { renderToStaticMarkup } from "react-dom/server";
import { CrashCard, ErrorBoundary } from "./components/boundary.tsx";
import { ConnectionGate } from "./components/connection-gate.tsx";
import {
	isChunkError,
	reloadForChunk,
	shouldReloadFor,
} from "./lib/chunk-error.ts";
import { composingKey } from "./lib/ime.ts";
import {
	type AppConnection,
	setConnection,
	useConnection,
} from "./lib/socket.ts";

afterEach(() => setConnection(undefined));

function Probe() {
	useConnection();
	return <p>connected</p>;
}

test("a first render under the gate finds the connection it asks for, as a room opened by a reload does", () => {
	setConnection(undefined);
	// Without the gate the first render throws, which blanked the page.
	expect(() => renderToStaticMarkup(<Probe />)).toThrow("not connected");
	let started = 0;
	const html = renderToStaticMarkup(
		<ConnectionGate
			protocol="p"
			make={() =>
				partial<AppConnection>({
					start: () => {
						started += 1;
					},
				})
			}
		>
			<Probe />
		</ConnectionGate>,
	);
	expect(html).toBe("<p>connected</p>");
	expect(started).toBe(1);
});

test("Enter that commits an input method's text is not a send, in Chromium's and in Safari's order of events", () => {
	// Chromium: the keydown is still inside the composition.
	expect(composingKey({ isComposing: true, keyCode: 13 })).toBe(true);
	// Safari: compositionend came first, and the keydown reports 229.
	expect(composingKey({ isComposing: false, keyCode: 229 })).toBe(true);
	expect(composingKey({ isComposing: false, keyCode: 13 })).toBe(false);
});

test("only a failure to load code counts as a chunk error", () => {
	for (const message of [
		"Failed to fetch dynamically imported module: https://x.test/assets/notes-ab12.js",
		"error loading dynamically imported module",
		"Importing a module script failed.",
		"Loading chunk 7 failed.",
	])
		expect(isChunkError(new TypeError(message))).toBe(true);
	expect(isChunkError(new Error("the owner app is not connected"))).toBe(false);
	expect(isChunkError(undefined)).toBe(false);
});

test("a failed chunk reloads the page once in a minute, then shows the card", () => {
	const kept = new Map<string, string>();
	const storage = {
		getItem: (key: string) => kept.get(key) ?? null,
		setItem: (key: string, value: string) => void kept.set(key, value),
	};
	let reloads = 0;
	const reload = () => {
		reloads += 1;
	};
	expect(reloadForChunk(storage, 1_000, reload)).toBe(true);
	expect(reloadForChunk(storage, 20_000, reload)).toBe(false);
	expect(reloads).toBe(1);
	expect(reloadForChunk(storage, 120_000, reload)).toBe(true);
	expect(reloads).toBe(2);
	expect(shouldReloadFor("not a number", 5)).toBe(true);
	// A page that cannot remember a reload does not risk a loop.
	const broken = {
		getItem: () => {
			throw new Error("blocked");
		},
		setItem: () => undefined,
	};
	expect(reloadForChunk(broken, 1, reload)).toBe(false);
});

test("the card that replaces a failed page says why and offers Reload", () => {
	const updated = renderToStaticMarkup(
		<CrashCard
			error={new TypeError("Failed to fetch dynamically imported module")}
			onReload={() => undefined}
		/>,
	);
	expect(updated).toContain("The app was updated");
	expect(updated).toContain(">Reload<");
	const other = renderToStaticMarkup(
		<CrashCard error={new Error("boom")} onReload={() => undefined} />,
	);
	expect(other).toContain("This page stopped working");
});

test("RV-F005: a failed page's error card is cleared when the route it stood for changes, and kept while the route is the same", () => {
	const failed = {
		...ErrorBoundary.getDerivedStateFromError(new Error("boom")),
		key: "room/a",
	};
	const props = (resetKey: string) => ({ children: null, resetKey });
	expect(ErrorBoundary.getDerivedStateFromProps(props("room/a"), failed)).toBe(
		null,
	);
	expect(
		ErrorBoundary.getDerivedStateFromProps(props("room/b"), failed),
	).toEqual({ error: undefined, key: "room/b" });
});
