// What the "all features" grid holds: the fixed entries of the app and every pane or main page the
// config names, in three groups. The account's own entries (profile, settings, connectors, the
// scheme, logging out) are in the menu under the person's picture, and the cards waiting have their
// button in the home's top row, so neither is here. Pure, so a test needs no browser; the sheet
// draws what it returns.

import type { PageLinkView, PaneName } from "../../src/api-types.ts";
import type { IconName } from "../components/icons.tsx";
import { PANE_ICONS, PANE_LABELS } from "../pages/more.tsx";
import { translate as t } from "./messages.ts";

/** What pressing a tile does. */
export type TileAction = { kind: "go"; pane: string } | { kind: "arrange" };

export interface Tile {
	id: string;
	label: string;
	icon: IconName;
	action: TileAction;
}

export interface TileGroup {
	id: "organize" | "work" | "assistant";
	title: string;
	tiles: Tile[];
}

export interface FeatureInput {
	panes: readonly PaneName[];
	pages: readonly PageLinkView[];
	/** The owner app is served: its arranging and hiding exist. */
	hasApp: boolean;
}

export function featureGroups(input: FeatureInput): TileGroup[] {
	const { panes, hasApp } = input;
	const pane = (name: PaneName): Tile[] =>
		panes.includes(name)
			? [
					{
						id: name,
						label: t(PANE_LABELS[name]),
						icon: PANE_ICONS[name],
						action: { kind: "go", pane: name },
					},
				]
			: [];
	const own = (
		id: string,
		label: string,
		icon: IconName,
		action: TileAction,
	): Tile => ({ id, label, icon, action });
	const groups: TileGroup[] = [
		{
			id: "organize",
			title: t("Organize"),
			tiles: [
				...(hasApp
					? [
							own("arrange", t("Folders and order"), "folder", {
								kind: "arrange",
							}),
						]
					: []),
				...pane("schedules"),
				...(hasApp
					? [
							own("hidden", t("Hidden and archived"), "archive", {
								kind: "go",
								pane: "hidden",
							}),
						]
					: []),
			],
		},
		{
			id: "work",
			title: t("Work"),
			tiles: [
				...pane("workspace"),
				...pane("table"),
				...pane("overview"),
				...pane("conversations"),
				// The host's own pages stand with the work.
				...input.pages
					.filter((page) => page.place === "main")
					.map((page) =>
						own(`p/${page.id}`, page.label, (page.icon ?? "list") as IconName, {
							kind: "go",
							pane: `p/${page.id}`,
						}),
					),
			],
		},
		{
			id: "assistant",
			title: t("Knights"),
			tiles: [
				...pane("notes"),
				...pane("skills"),
				...pane("presets"),
				...pane("webhooks"),
			],
		},
	];
	return groups.filter((group) => group.tiles.length > 0);
}
