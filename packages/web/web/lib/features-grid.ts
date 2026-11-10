// What the "all features" grid holds: the fixed entries of the app and every pane or main page the
// config names, in four groups. Pure, so a test needs no browser; the sheet draws what it returns.

import type { PageLinkView, PaneName } from "../../src/api-types.ts";
import type { IconName } from "../components/icons.tsx";
import { PANE_ICONS, PANE_LABELS } from "../pages/more.tsx";
import { translate as t } from "./messages.ts";

/** What pressing a tile does. */
export type TileAction =
	| { kind: "go"; pane: string }
	| { kind: "arrange" }
	| { kind: "waiting" }
	| { kind: "theme" };

export interface Tile {
	id: string;
	label: string;
	icon: IconName;
	action: TileAction;
	/** A count on the tile's corner, such as the cards waiting. */
	badge?: number;
}

export interface TileGroup {
	id: "organize" | "work" | "assistant" | "system";
	title: string;
	tiles: Tile[];
}

export interface FeatureInput {
	panes: readonly PaneName[];
	pages: readonly PageLinkView[];
	/** The owner app is served: its arranging, hiding, settings and profile exist. */
	hasApp: boolean;
	waiting: number;
	/** The page is dark now, so the toggle offers light. */
	dark: boolean;
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
		badge?: number,
	): Tile => ({
		id,
		label,
		icon,
		action,
		...(badge ? { badge } : {}),
	});
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
							own(
								"waiting",
								t("Waiting"),
								"hourglass",
								{ kind: "waiting" },
								input.waiting,
							),
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
		{
			id: "system",
			title: t("System"),
			tiles: [
				...pane("connectors"),
				...(hasApp
					? [
							own("settings", t("Settings"), PANE_ICONS.settings, {
								kind: "go",
								pane: "settings",
							}),
						]
					: []),
				// The profile is a pane a host opts into: without it the route does not open.
				...pane("profile"),
				own(
					"theme",
					input.dark ? t("Switch to light") : t("Switch to dark"),
					input.dark ? "sun" : "moon",
					{ kind: "theme" },
				),
			],
		},
	];
	return groups.filter((group) => group.tiles.length > 0);
}
