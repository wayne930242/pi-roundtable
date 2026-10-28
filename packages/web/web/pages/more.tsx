import type { PaneName } from "../../src/api-types.ts";
import { Icon, type IconName } from "../components/icons.tsx";
import { translate as t } from "../lib/messages.ts";
import { hrefFor } from "../lib/router.ts";

export const PANE_ICONS: Record<PaneName | "settings" | "more", IconName> = {
	rooms: "rooms",
	schedules: "schedules",
	overview: "overview",
	conversations: "conversations",
	notes: "notes",
	skills: "skills",
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
