import { openMenu } from "./action-menu.ts";
import { type PressProps, useLongPress } from "./long-press.ts";
import type { MenuSpec } from "./menu-items.ts";

/**
 * The props that make an element open an action menu on a long press, a right click or the Menu
 * key. `build` is asked as the menu opens, with the element pressed; it resolves to nothing when
 * the element has no menu then, and the press does nothing. A builder that cannot load is a
 * press that does nothing.
 */
export function useMenuPress(
	build: (source: HTMLElement) => Promise<MenuSpec | undefined>,
	options: { selectable?: boolean } = {},
): PressProps {
	return useLongPress((request) => {
		build(request.source).then(
			(spec) => {
				if (spec)
					openMenu({
						...spec,
						at: request.at,
						via: request.via,
						source: request.source,
					});
			},
			() => undefined,
		);
	}, options);
}
