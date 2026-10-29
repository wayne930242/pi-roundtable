import { useConfig } from "../lib/config.ts";
import { translate as t } from "../lib/messages.ts";
import { hrefFor } from "../lib/router.ts";
import { Icon } from "./icons.tsx";

/** The host's own pages that belong with settings: a link to each. */
export default function HostSettingsPages() {
	const pages = (useConfig().pages ?? []).filter(
		(page) => page.place === "settings",
	);
	if (pages.length === 0) return null;
	return (
		<section className="card stack">
			<h2>{t("More settings")}</h2>
			{pages.map((page) => (
				<a
					key={page.id}
					className="menu-item menu-link"
					href={hrefFor("p", page.id)}
				>
					<span className="menu-text">
						<strong>{page.label}</strong>
					</span>
					<Icon name="chevron" size={16} />
				</a>
			))}
		</section>
	);
}
