import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConfigView } from "../src/api-types.ts";
import { ConfigContext } from "./lib/config.ts";
import { RoomsPage } from "./pages/rooms.tsx";

const config: ConfigView = {
	title: "Console",
	panes: ["rooms"],
	timeZone: "UTC",
	look: "modern",
};

// On a phone the button's words are `display: none`, so its name must not rest on them: a screen
// reader would find an icon and nothing else.
test("the rooms page's search button has a name of its own, not the words a phone hides", () => {
	const html = renderToStaticMarkup(
		<ConfigContext.Provider value={config}>
			<RoomsPage onSearch={() => undefined} />
		</ConfigContext.Provider>,
	);
	const tag = html.match(/<button[^>]*search-button[^>]*>/)?.[0] ?? "";
	expect(tag).toContain('aria-label="Find a room"');
});
