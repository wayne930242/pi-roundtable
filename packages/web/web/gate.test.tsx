import { afterAll, beforeAll, expect, test } from "bun:test";
import { partial } from "pi-roundtable/testing";
import type { ConfigView, GateStepView } from "../src/api-types.ts";
import { RoomMenu } from "./components/room-menu.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { ConfigContext } from "./lib/config.ts";
import { loadKit } from "./lib/kit.ts";
import { GATE_ROUTES, PAGE_ROUTES } from "./lib/page-routes.ts";
import { setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import { GatePage } from "./pages/gate.tsx";
import { LogoutForm } from "./pages/logout.tsx";

let page: TestPage;
beforeAll(async () => {
	await loadKit();
	page = await openPage();
	setRouting(undefined);
	setConnection(partial<AppConnection>({ send: () => true }));
});
afterAll(async () => {
	setConnection(undefined);
	await page.unmount();
	await releaseDom();
});

const q = (selector: string) => page.container.querySelector(selector);
const all = (selector: string) => [
	...page.container.querySelectorAll(selector),
];

const STEPS: GateStepView[] = [
	{
		id: "name",
		label: "Tell us your name",
		help: "Shown to your team.",
		required: true,
		open: { page: "profile" },
	},
	{
		id: "links",
		label: "Link your account",
		required: true,
		open: { page: "onboarding" },
	},
];

test("the gate lists every step owed, each with the page that finishes it", async () => {
	await page.render(<GatePage steps={STEPS} />);
	expect(all(".menu-text strong").map((one) => one.textContent)).toEqual([
		"Tell us your name",
		"Link your account",
	]);
	expect(q(".menu-text .meta")?.textContent).toBe("Shown to your team.");
	expect(all("a.menu-link").map((one) => one.getAttribute("href"))).toEqual([
		"#/profile",
		"#/onboarding",
	]);
});

test("a person who owes a step may still open their profile and settings", () => {
	for (const route of ["profile", "settings", "onboarding", "notices"])
		expect(GATE_ROUTES.has(route)).toBe(true);
	for (const route of ["rooms", "conversations", "notes", "schedules"])
		expect(GATE_ROUTES.has(route)).toBe(false);
	// The pages a host adds load on first open, so they cost the first load nothing.
	expect(Object.keys(PAGE_ROUTES)).toContain("profile");
});

test("log out is offered for a session the app keeps, and not for a proxy's sign-in", async () => {
	for (const auth of ["password", "oidc"] as const) {
		await page.render(<LogoutForm auth={auth} />);
		expect(q('form[action="auth/logout"]')).not.toBeNull();
	}
	for (const auth of ["verifier", "none"] as const) {
		await page.render(<LogoutForm auth={auth} />);
		expect(q("form")).toBeNull();
	}
});

const config = (modes?: false): ConfigView => ({
	title: "Console",
	panes: ["rooms"],
	timeZone: "UTC",
	look: "modern",
	app: { surface: "app", protocol: "p", ...(modes === false ? { modes } : {}) },
});

const menuLabels = () => all(".menu-text strong").map((one) => one.textContent);
const menu = (value: ConfigView) => (
	<ConfigContext.Provider value={value}>
		<RoomMenu
			open
			room="app:agent.scout"
			mode={{ yolo: false, longRunning: false }}
			onClose={() => undefined}
			onAskYolo={() => undefined}
			onAskStartOver={() => undefined}
		/>
	</ConfigContext.Provider>
);

test("a room's menu has the yolo and long-running switches, unless the host left them out", async () => {
	await page.render(menu(config()));
	expect(menuLabels()).toContain("Yolo mode");
	expect(menuLabels()).toContain("Long-running mode");
	await page.render(menu(config(false)));
	expect(menuLabels()).not.toContain("Yolo mode");
	expect(menuLabels()).not.toContain("Long-running mode");
});
