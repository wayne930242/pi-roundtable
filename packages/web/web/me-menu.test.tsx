import { expect, spyOn, test } from "bun:test";
import type { ConfigView, SessionView } from "../src/api-types.ts";
import { chatsConfig, Home, loadChats, seed } from "./chats-fixture.tsx";
import { foldersPage, page, q, until } from "./folders-fixture.tsx";
import { api } from "./lib/api.ts";
import { setTheme } from "./lib/theme.ts";
import { labels, menuItems } from "./menus-fixture.tsx";

foldersPage();

const choose = async (label: string) => {
	const item = menuItems().find((one) => one.textContent === label);
	if (!item) throw new Error(`no menu item ${label}: ${labels().join(", ")}`);
	await page.click(item);
	await new Promise((done) => setTimeout(done, 80));
};

const SESSION = {
	principal: { name: "Wei Hung" },
	auth: "password",
} as unknown as SessionView;
const served = (panes: ConfigView["panes"]): ConfigView => ({
	...chatsConfig,
	panes,
});
const NOT_SERVED = served(["rooms", "schedules"]);

const open = async (config: ConfigView, session = SESSION) => {
	seed();
	loadChats();
	spyOn(api, "session").mockResolvedValue(session);
	await page.render(<Home config={config} />);
	await until(() => q(".chats-me") !== null);
	await page.click(q(".chats-me") as HTMLElement);
	await until(() => q('[role="menu"]') !== null);
};

test("the person's picture opens a menu titled with their name; Profile is in it only when the host serves the profile pane", async () => {
	await open(chatsConfig);
	expect(q(".chats-me")?.getAttribute("aria-haspopup")).toBe("menu");
	expect(q('[role="menu"]')?.getAttribute("aria-label")).toBe(
		"Signed in as Wei Hung",
	);
	expect(labels()).toEqual([
		"Profile",
		"Settings",
		"Switch to dark",
		"Log out",
	]);
});

test("a host that does not serve the profile pane has no Profile item", async () => {
	await open(NOT_SERVED);
	expect(labels()).not.toContain("Profile");
	expect(labels()).toContain("Settings");
});

test("Settings and Profile navigate; the theme item switches the scheme", async () => {
	await open(chatsConfig);
	await choose("Settings");
	expect(location.hash).toContain("settings");
	await open(chatsConfig);
	await choose("Profile");
	expect(location.hash).toContain("profile");
	setTheme("light");
	await open(chatsConfig);
	await choose("Switch to dark");
	expect(document.documentElement.dataset.theme ?? "").toBe("dark");
});

test("Log out posts the logout form to the server", async () => {
	await open(chatsConfig);
	const posted: string[] = [];
	const submit = spyOn(HTMLFormElement.prototype, "submit").mockImplementation(
		function (this: HTMLFormElement) {
			posted.push(`${this.method} ${this.getAttribute("action")}`);
		},
	);
	await choose("Log out");
	await until(() => posted.length > 0);
	expect(posted).toEqual(["post auth/logout"]);
	submit.mockRestore();
});

test("a sign-in the app keeps no session of (a proxy's) has no Log out item", async () => {
	await open(chatsConfig, { ...SESSION, auth: "none" } as SessionView);
	expect(labels()).not.toContain("Log out");
});
