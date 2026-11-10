// The "me" menu under a person's picture on the chat home: who is signed in, their profile where
// the host serves one, settings, the scheme, and logging out. It loads with the
// first menu, not with the page.

import type { SessionView } from "../../src/api-types.ts";
import { type MenuItem, openMenu } from "./action-menu.ts";
import { api } from "./api.ts";
import { store } from "./app-store.ts";
import type { MenuSpec } from "./menu-items.ts";
import { translate as t } from "./messages.ts";
import { disablePush } from "./push.ts";
import { navigate } from "./router.ts";
import { resolvedTheme, setTheme } from "./theme.ts";

export interface MeMenuOptions {
	/** The host serves the profile pane; where it does not, the route opens nothing. */
	profile: boolean;
}

/** Stops this device's pushes, then posts the logout form so the server clears the cookie. */
async function logOut(): Promise<void> {
	await disablePush().catch(() => undefined);
	const form = document.createElement("form");
	form.method = "post";
	form.action = "auth/logout";
	form.hidden = true;
	document.body.append(form);
	form.submit();
}

/** The items of the menu; the session says whether a log out is the app's to offer. */
export async function meMenu(
	options: MeMenuOptions,
	origin: { x: number; y: number },
): Promise<MenuSpec> {
	const session: SessionView | undefined = await api
		.session()
		.catch(() => undefined);
	const name = session?.principal.name ?? store.getState().principal?.name;
	const dark = resolvedTheme() === "dark";
	const items: MenuItem[] = [];
	if (options.profile)
		items.push({
			id: "profile",
			label: t("Profile"),
			icon: "profile",
			run: () => navigate("profile"),
		});
	items.push({
		id: "settings",
		label: t("Settings"),
		icon: "settings",
		run: () => navigate("settings"),
	});
	items.push({
		id: "theme",
		label: dark ? t("Switch to light") : t("Switch to dark"),
		icon: dark ? "sun" : "moon",
		run: () => setTheme(dark ? "light" : "dark", origin),
	});
	if (session && (session.auth === "password" || session.auth === "oidc"))
		items.push({
			id: "logout",
			label: t("Log out"),
			icon: "logout",
			run: logOut,
		});
	return {
		title: name ? t("Signed in as {name}", { name }) : t("Account"),
		items,
	};
}

/** Opens the menu under the person's picture. */
export async function openMeMenu(
	button: HTMLElement,
	options: MeMenuOptions,
): Promise<void> {
	const box = button.getBoundingClientRect();
	const spec = await meMenu(options, {
		x: box.left + box.width / 2,
		y: box.top + box.height / 2,
	});
	openMenu({
		...spec,
		heading: spec.title,
		at: { x: box.left, y: box.bottom },
		via: "key",
		source: button,
	});
}
