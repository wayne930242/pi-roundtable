import { expect, test } from "bun:test";
import type { PaneName } from "../src/api-types.ts";
import { featureGroups } from "./lib/features-grid.ts";

const ALL: PaneName[] = [
	"rooms",
	"schedules",
	"table",
	"workspace",
	"overview",
	"conversations",
	"notes",
	"skills",
	"presets",
	"webhooks",
	"connectors",
	"profile",
];

const ids = (groups: ReturnType<typeof featureGroups>) =>
	groups.map((group) => [group.id, group.tiles.map((tile) => tile.id)]);

test("the three groups hold the fixed entries and every pane the config names, in the spec's order", () => {
	const groups = featureGroups({ panes: ALL, pages: [], hasApp: true });
	expect(ids(groups)).toEqual([
		["organize", ["arrange", "schedules", "hidden"]],
		["work", ["workspace", "table", "overview", "conversations"]],
		["assistant", ["notes", "skills", "presets", "webhooks"]],
	]);
});

test("the account's entries and the cards waiting are not tiles: the picture's menu and the top row have them", () => {
	const tiles = featureGroups({ panes: ALL, pages: [], hasApp: true }).flatMap(
		(group) => group.tiles.map((tile) => tile.id),
	);
	for (const id of ["connectors", "settings", "profile", "theme", "waiting"])
		expect(tiles).not.toContain(id);
});

test("a host with fewer panes shows fewer tiles, and a group with none is left out", () => {
	const groups = featureGroups({
		panes: ["rooms", "schedules", "workspace"],
		pages: [],
		hasApp: true,
	});
	expect(ids(groups)).toEqual([
		["organize", ["arrange", "schedules", "hidden"]],
		["work", ["workspace"]],
	]);
});

test("the host's main pages stand in the work group by their own label and icon; its other places are not here", () => {
	const groups = featureGroups({
		panes: ["rooms"],
		pages: [
			{ id: "crm", label: "CRM", place: "main", icon: "bolt" as never },
			{ id: "sub", label: "Sub", place: "settings" },
			{ id: "gone", label: "Gone", place: "hidden" },
		],
		hasApp: true,
	});
	const work = groups.find((group) => group.id === "work");
	expect(work?.tiles.map((tile) => [tile.id, tile.label, tile.action])).toEqual(
		[["p/crm", "CRM", { kind: "go", pane: "p/crm" }]],
	);
});

test("without the owner app there is no arranging or hiding", () => {
	const groups = featureGroups({
		panes: ["overview", "notes"],
		pages: [],
		hasApp: false,
	});
	expect(ids(groups)).toEqual([
		["work", ["overview"]],
		["assistant", ["notes"]],
	]);
});
