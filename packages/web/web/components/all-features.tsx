import { store, useSelector } from "../lib/app-store.ts";
import { setArranging } from "../lib/arrange.ts";
import { useConfig } from "../lib/config.ts";
import {
	featureGroups,
	type Tile,
	type TileAction,
} from "../lib/features-grid.ts";
import { useLive } from "../lib/live.ts";
import { translate as t } from "../lib/messages.ts";
import { navigate } from "../lib/router.ts";
import { openCards } from "../lib/tab-count.ts";
import { setTheme, useTheme } from "../lib/theme.ts";
import { toast } from "../lib/toast.ts";
import { Icon } from "./icons.tsx";
import { Sheet } from "./sheet.tsx";

/** Does what a tile means; `dark` is the scheme the page shows now. */
function run(action: TileAction, box: DOMRect, dark: boolean): void {
	switch (action.kind) {
		case "go":
			navigate(action.pane);
			return;
		case "arrange":
			// The management view is the sectioned list in arrange mode.
			setArranging(true);
			navigate("arrange");
			return;
		case "waiting":
			if (openCards(store.getState()) === 0) toast(t("No cards are waiting."));
			else import("../lib/waiting.ts").then((m) => m.openWaiting());
			return;
		case "theme":
			setTheme(dark ? "light" : "dark", {
				x: box.left + box.width / 2,
				y: box.top + box.height / 2,
			});
	}
}

/**
 * Everything the home leaves out, one layer down: the app's pages and panes in four groups, and the
 * connection state. A sheet on a phone, a popover beside the grid button on a wide screen.
 */
export function AllFeatures(props: { open: boolean; onClose(): void }) {
	const config = useConfig();
	const { resolved } = useTheme();
	const waiting = useSelector(openCards);
	const { connected } = useLive();
	const connection = useSelector((state) => state.connection);
	const online = config.app ? connection === "open" : connected;
	const dark = resolved === "dark";
	const groups = featureGroups({
		panes: config.panes,
		pages: config.pages ?? [],
		hasApp: config.app !== undefined,
		waiting,
		dark,
	});
	const press = (tile: Tile, source: HTMLElement) => {
		// Measured now: the tile is gone with the sheet's body once it closes.
		const box = source.getBoundingClientRect();
		props.onClose();
		// The sheet slides away first, so the page that opens is not behind it.
		setTimeout(() => run(tile.action, box, dark), 0);
	};
	return (
		<Sheet
			open={props.open}
			title={t("All features")}
			variant="features"
			onClose={props.onClose}
		>
			<div className="features">
				{groups.map((group) => (
					<section key={group.id} className="feature-group">
						<h3>{group.title}</h3>
						<ul>
							{group.tiles.map((tile) => (
								<li key={tile.id}>
									<button
										type="button"
										className="feature-tile"
										onClick={(event) => press(tile, event.currentTarget)}
									>
										<span className="feature-icon">
											<Icon name={tile.icon} size={26} />
											{tile.badge ? (
												<span className="feature-badge">{tile.badge}</span>
											) : null}
										</span>
										<span className="feature-label">{tile.label}</span>
									</button>
								</li>
							))}
						</ul>
					</section>
				))}
				<p className="live-chip" data-on={online || undefined}>
					{online ? t("Receiving live updates") : t("Reconnecting")}
				</p>
			</div>
		</Sheet>
	);
}
