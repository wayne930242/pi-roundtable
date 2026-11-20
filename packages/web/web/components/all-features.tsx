import { setArranging } from "../lib/arrange.ts";
import { useConfig } from "../lib/config.ts";
import {
	featureGroups,
	type Tile,
	type TileAction,
} from "../lib/features-grid.ts";
import { translate as t } from "../lib/messages.ts";
import { navigate } from "../lib/router.ts";
import { Icon } from "./icons.tsx";
import { Sheet } from "./sheet.tsx";

/** Does what a tile means. */
function run(action: TileAction): void {
	switch (action.kind) {
		case "go":
			navigate(action.pane);
			return;
		case "arrange":
			// The management view is the sectioned list in arrange mode.
			setArranging(true);
			navigate("arrange");
	}
}

/**
 * Everything the home leaves out, one layer down: the app's pages and panes in three groups. A
 * sheet of big tiles on a phone; on a wide screen a compact popover beside the grid button, a row
 * per entry in two columns.
 */
export function AllFeatures(props: { open: boolean; onClose(): void }) {
	const config = useConfig();
	const groups = featureGroups({
		panes: config.panes,
		pages: config.pages ?? [],
		hasApp: config.app !== undefined,
	});
	const press = (tile: Tile) => {
		props.onClose();
		// The sheet slides away first, so the page that opens is not behind it.
		setTimeout(() => run(tile.action), 0);
	};
	return (
		<Sheet
			open={props.open}
			title={t("All features")}
			variant="features"
			onClose={props.onClose}
		>
			<div className="feature-groups">
				{groups.map((group) => (
					<section key={group.id} className="feature-group">
						<h3>{group.title}</h3>
						<ul>
							{group.tiles.map((tile) => (
								<li key={tile.id}>
									<button
										type="button"
										className="feature-tile"
										onClick={() => press(tile)}
									>
										<span className="feature-icon">
											<Icon name={tile.icon} size={26} />
										</span>
										<span className="feature-label">{tile.label}</span>
									</button>
								</li>
							))}
						</ul>
					</section>
				))}
			</div>
		</Sheet>
	);
}
