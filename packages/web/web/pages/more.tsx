import type { PaneName } from "../../src/api-types.ts";
import { Icon, type IconName } from "../components/icons.tsx";
import { translate as t, wording } from "../lib/messages.ts";
import { hrefFor } from "../lib/router.ts";

/** The English names of the panes in the navigation, translated where they are drawn. */
export const PANE_LABELS: Record<PaneName | "settings" | "more", string> = {
	overview: wording("Overview"),
	conversations: wording("Conversations"),
	notes: wording("Notes"),
	skills: wording("Skills"),
	presets: wording("Presets"),
	webhooks: wording("Webhooks"),
	connectors: wording("Connectors"),
	rooms: wording("Rooms"),
	schedules: wording("Schedules"),
	table: wording("Round table"),
	workspace: wording("Files"),
	profile: wording("Profile"),
	settings: wording("Settings"),
	more: wording("More"),
};

export const PANE_ICONS: Record<PaneName | "settings" | "more", IconName> = {
	rooms: "rooms",
	schedules: "schedules",
	table: "table",
	workspace: "file",
	profile: "profile",
	overview: "overview",
	conversations: "conversations",
	notes: "notes",
	skills: "skills",
	presets: "copy",
	webhooks: "bolt",
	connectors: "connectors",
	settings: "settings",
	more: "more",
};

/** Everything the tab bar has no room for: the other panes and the settings. */
export function MorePage(props: { items: { pane: string; label: string }[] }) {
	return (
		<div className="page">
			<header className="page-head">
				<h1>{t("More")}</h1>
			</header>
			<ul className="more-list">
				{props.items.map((item) => (
					<li key={item.pane}>
						<a className="menu-item menu-link" href={hrefFor(item.pane)}>
							<span className="menu-icon">
								<Icon
									name={
										PANE_ICONS[item.pane as keyof typeof PANE_ICONS] ?? "list"
									}
								/>
							</span>
							<span className="menu-text">
								<strong>{item.label}</strong>
							</span>
							<Icon name="chevron" size={16} />
						</a>
					</li>
				))}
			</ul>
		</div>
	);
}
