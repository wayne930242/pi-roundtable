// The frame of a room and of the chat column must not scroll away. The test runs without layout, so
// it reads the rules that hold the frame in place.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CHATS_HOME_CSS } from "./lib/chats-home-style.ts";

const read = (path: string) =>
	readFileSync(new URL(path, import.meta.url), "utf8");
/** The declarations of the first rule with exactly this selector. */
const rule = (css: string, selector: string): string => {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const found = new RegExp(`(?:^|\\n)${escaped}\\s*{([^}]*)}`).exec(css);
	if (!found) throw new Error(`no rule for ${selector}`);
	return found[1] ?? "";
};

test("what a message positions is held by the message scroller, not the room, so it cannot stretch the room past the screen", () => {
	expect(rule(read("./app.css"), ".room-scroll")).toMatch(
		/\n\tposition: relative;/,
	);
});

test("a page that fills the screen clips, so a scroll into view cannot move its frame", () => {
	expect(rule(read("./styles.css"), ".stage[data-fill]")).toMatch(
		/overflow: clip;/,
	);
});

test("in the column beside a room the top row sticks to the top and the column reaches the bottom", () => {
	expect(rule(CHATS_HOME_CSS, ".split-list .chats[data-column]")).toMatch(
		/min-height: 100%;/,
	);
	const top = rule(
		CHATS_HOME_CSS,
		".split-list .chats[data-column] .chats-top",
	);
	expect(top).toMatch(/position: sticky;/);
	expect(top).toMatch(/top: 0;/);
	expect(top).toMatch(/background: var\(--bg\);/);
	expect(rule(CHATS_HOME_CSS, ".chats-foot")).toMatch(/position: sticky;/);
});
