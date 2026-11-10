import { expect, spyOn, test } from "bun:test";
import { store } from "./lib/app-store.ts";
import { setHomeMode } from "./lib/home-mode.ts";
import { pinRoom } from "./lib/layout-actions.ts";
import { layoutApi } from "./lib/layout-api.ts";
import { knownPane } from "./lib/page-routes.ts";

test("arrange and hidden open only on the chat home", () => {
	for (const name of ["arrange", "hidden"]) {
		expect(knownPane(name, ["rooms"], true, false)).toBe(false);
		expect(knownPane(name, ["rooms"], true, true)).toBe(true);
	}
	expect(knownPane("room", ["rooms"], true, false)).toBe(true);
	expect(knownPane("presets", ["rooms"], true, false)).toBe(true);
});

test("a layout edit on the rooms home keeps no server hidden rooms", async () => {
	setHomeMode("rooms");
	spyOn(layoutApi, "pinRoom").mockResolvedValue({
		pins: ["app:agent.a"],
		hidden: ["app:agent.b"],
		folders: [],
	});
	await pinRoom("app:agent.a", true);
	expect(store.getState().hidden).toEqual([]);
});

test("the profile route opens only where the host serves the profile pane, owner app or not", () => {
	expect(knownPane("profile", ["rooms"], true, true)).toBe(false);
	expect(knownPane("profile", ["rooms", "profile"], true, true)).toBe(true);
});
