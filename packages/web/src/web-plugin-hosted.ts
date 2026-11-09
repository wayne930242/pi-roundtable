import type { Logger } from "pi-roundtable";
import type { KindLinkView, PageLinkView } from "./api-types.ts";
import type { AccessView, ConsolePorts } from "./console-api.ts";
import type { Gate } from "./gate.ts";
import type { ResolvedOptions } from "./options.ts";
import { hostIcon, viewerOf, type WebAppRegistry } from "./web-app.ts";

/** The pages and kinds of room the host registered, as far as a visitor may see them. */
export function hostedLinks(
	webApp: WebAppRegistry,
	logger: Logger,
): ConsolePorts["hosted"] {
	/** The `icon` of a link when the host named one of the console's icons. */
	const iconOf = (name: unknown) => {
		const icon = hostIcon(name);
		return icon ? { icon } : {};
	};
	return async (visitor) => {
		const viewer = viewerOf(visitor);
		const pages: PageLinkView[] = [];
		for (const page of webApp.hostPages()) {
			try {
				if (await page.visible(viewer))
					pages.push({
						id: page.id,
						label: page.label,
						place: page.place,
						...iconOf(page.icon),
					});
			} catch (error) {
				logger.warn(
					{ page: page.id, err: error },
					"a page's visibility was not read",
				);
			}
		}
		const kinds: KindLinkView[] = [];
		for (const kind of webApp.kinds()) {
			try {
				if ((await kind.list(viewer, {})) !== undefined)
					kinds.push({
						kind: kind.kind,
						label: kind.label,
						...iconOf(kind.icon),
					});
			} catch (error) {
				logger.warn(
					{ kind: kind.kind, err: error },
					"a kind of room was not listed",
				);
			}
		}
		return { pages, kinds };
	};
}

/** What the app adds to the page's config where the console admits more than its owners. */
export function accessViewOf(
	settings: ResolvedOptions,
	gate: Gate,
): AccessView | undefined {
	return settings.admission === "access"
		? {
				push: {
					tiers: settings.push.tiers,
					...(settings.push.sender !== "internal"
						? {
								key: settings.push.sender.external.publicKey,
								...(settings.push.sender.external.subscribePath
									? {
											subscribe: settings.push.sender.external.subscribePath,
										}
									: {}),
							}
						: {}),
				},
				gate: (visitor) => gate.required(viewerOf(visitor)),
			}
		: undefined;
}
