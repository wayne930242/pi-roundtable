import { afterEach, expect, spyOn, test } from "bun:test";
import type {
	ConfigView,
	ConversationView,
	OverviewView,
} from "../src/api-types.ts";
import { ActionMenuHost } from "./components/action-menu.tsx";
import { Toaster } from "./components/toaster.tsx";
import {
	all,
	dialog,
	foldersPage,
	labels,
	page,
	q,
	settle,
	stored,
	until,
} from "./folders-fixture.tsx";
import { api } from "./lib/api.ts";
import { ConfigContext } from "./lib/config.ts";
import { COLLAPSED_KEY, reloadCollapsed } from "./lib/folds.ts";
import { OverviewPage } from "./pages/overview.tsx";

foldersPage();

const DAY = 86_400_000;
const ago = (days: number) =>
	new Date(Date.now() - days * DAY - 3_600_000).toISOString();

const work = (
	id: string,
	days: number,
	over: Partial<ConversationView> = {},
): ConversationView & { schedules: number } => ({
	key: `discord:${id}`,
	kind: "owner",
	id,
	channel: { kind: "guild", name: id, guild: "Camelot", guildId: "g1" },
	liveBytes: 2 * 1024 * 1024,
	archives: 1,
	lastActive: ago(days),
	busy: 0,
	schedules: 0,
	...over,
});

const VIEW: OverviewView = {
	guildId: "g1",
	agents: [
		{
			name: "scout",
			displayName: "Scout",
			model: "m/one",
			thinking: "low",
			waiting: 0,
			schedules: 0,
		},
	],
	groups: [],
	workspaces: [
		work("scratch", 31, { archives: 0 }),
		work("paper", 36, { liveBytes: 0, archives: 2 }),
		work("research", 41),
		work("recent", 3),
		work("today", 0.2),
	],
	outside: [
		{
			key: "mcp:s1",
			kind: "outside",
			id: "s1",
			firstMessage: "hello from outside",
			liveBytes: 1024,
			archives: 0,
			lastActive: ago(2),
			busy: 0,
		},
	],
	party: [],
};

const spies: { mockRestore(): void }[] = [];
const spy = <T extends { mockRestore(): void }>(one: T): T => {
	spies.push(one);
	return one;
};
afterEach(() => {
	for (const one of spies.splice(0)) one.mockRestore();
});

const config: ConfigView = {
	title: "Console",
	panes: ["overview", "conversations"],
	timeZone: "UTC",
	look: "modern",
	cleanup: true,
};

const Overview = () => (
	<ConfigContext.Provider value={config}>
		<OverviewPage />
		<ActionMenuHost />
		<Toaster />
	</ConfigContext.Provider>
);

async function open() {
	spy(spyOn(api, "overview").mockResolvedValue(VIEW));
	await page.render(<Overview />);
	await until(() => all(".stored-row").length > 0);
	await page.act(() => {
		for (const one of all<HTMLButtonElement>(
			'.toast button[aria-label="Dismiss"]',
		))
			one.click();
	});
}

const button = (
	text: string,
	...scope: [within?: ParentNode | null | undefined]
) => {
	const within = scope.length === 0 ? document : scope[0];
	if (!within) return null;
	return (
		[...within.querySelectorAll<HTMLButtonElement>("button")].find((one) =>
			one.textContent?.trim().startsWith(text),
		) ?? null
	);
};
const box = (name: string) =>
	all<HTMLInputElement>('input[type="checkbox"]').find(
		(one) => one.getAttribute("aria-label") === name,
	) ?? null;
const lastToast = () => all(".toast").at(-1) ?? null;
const count = () => q(".select-count")?.textContent;
const rowOf = (name: string) =>
	all(".stored-row").find((one) => one.textContent?.includes(name)) ?? null;

test("workspaces and outside conversations are short rows with last active, size and archives, not cards", async () => {
	await open();
	expect(all(".stored-row")).toHaveLength(6);
	// Only the knights' and party cards keep their card.
	expect(all("article.card")).toHaveLength(1);
	const research = rowOf("#research")?.textContent ?? "";
	expect(research).toContain("41 d ago");
	expect(research).toContain("2.0 MB");
	expect(research).toContain("1 archive");
	expect(rowOf("#paper")?.textContent).toContain("No live conversation");
	expect(rowOf("#paper")?.textContent).toContain("2 archives");
	expect(rowOf("#scratch")?.textContent).toContain("0 archives");
	expect(rowOf("hello from outside")?.textContent).toContain("1 KB");
	// The row holds no button of its own but the menu.
	expect(
		[...(rowOf("#research")?.querySelectorAll(":scope > button") ?? [])].map(
			(b) => b.getAttribute("aria-label"),
		),
	).toEqual(["More"]);
});

test("a row's menu holds Start over, Delete and Transcript, and the same questions as before", async () => {
	const startOver = spy(
		spyOn(api, "startOver").mockResolvedValue({ ok: true } as never),
	);
	await open();
	await page.click(rowOf("#research")?.querySelector(".row-more") ?? null);
	await until(() => labels().length > 0);
	expect(labels()).toEqual(["Start over", "Delete", "Transcript"]);
	const item = all('[role^="menuitem"]').find(
		(one) => one.textContent === "Start over",
	);
	await page.click(item ?? null);
	await until(() => dialog("Start over #research?")?.open === true);
	expect(startOver).not.toHaveBeenCalled();
	await page.click(button("Start over", dialog("Start over #research?")));
	await until(() => startOver.mock.calls.length === 1);
	expect(startOver).toHaveBeenCalledWith("discord:research");
});

test("selecting the rows idle for 30+ days and deleting asks first, sends one delete per row and names the one refused", async () => {
	const remove = spy(
		spyOn(api, "deleteConversation").mockImplementation(async (key: string) => {
			if (key === "discord:paper") throw new Error("The conversation is busy.");
			return { ok: true } as never;
		}),
	);
	await open();
	await page.click(button("Select"));
	await until(() => q('[role="toolbar"]') !== null);
	const chips = all("fieldset.select-chips").map((one) =>
		[...one.querySelectorAll("button")].map((b) =>
			b.textContent?.replace(/\s+/g, " "),
		),
	);
	expect(chips[0]).toEqual([
		"All 5",
		"No activity for 7+ days 3",
		"No activity for 30+ days 3",
	]);
	await page.click(
		button("No activity for 30+ days", all("fieldset.select-chips")[0]),
	);
	expect(all(".select-row")).toHaveLength(3 + 1);
	await page.click(button("Select all in section", all(".fold-head")[1]));
	expect(count()).toBe("3 selected");
	// A choice in the outside section starts that one over.
	await page.click(box("hello from outside"));
	expect(count()).toBe("1 selected");
	await page.click(button("Select all in section", all(".fold-head")[1]));
	expect(count()).toBe("3 selected");
	await page.click(button("Delete for good", q('[role="toolbar"]')));
	await until(() => dialog("Delete 3 items for good?")?.open === true);
	const asking = dialog("Delete 3 items for good?");
	expect(asking?.textContent).toContain("#scratch");
	expect(asking?.textContent).toContain("#paper");
	expect(asking?.textContent).toContain("#research");
	expect(asking?.textContent).toContain("4.0 MB in all");
	expect(button("Delete 3 for good", asking)).not.toBeNull();
	expect(remove).not.toHaveBeenCalled();
	await page.click(button("Delete 3 for good", asking));
	await until(() => q(".select-result") !== null);
	expect(remove.mock.calls.map((call) => call[0])).toEqual([
		"discord:scratch",
		"discord:paper",
		"discord:research",
	]);
	const result = q(".select-result")?.textContent ?? "";
	expect(result).toContain("1 was not done:");
	expect(result).toContain("#paper");
	expect(result).toContain("The conversation is busy.");
	expect(lastToast()?.textContent).toContain("Deleted 2 conversations");
});

test("a hold on a row starts selection with that row chosen", async () => {
	await open();
	await page.act(async () => {
		rowOf("#research")?.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				pointerType: "touch",
				isPrimary: true,
				clientX: 10,
				clientY: 10,
			}),
		);
		await settle(520);
	});
	await until(() => q('[role="toolbar"]') !== null);
	expect(box("#research")?.checked).toBe(true);
	expect(count()).toBe("1 selected");
});

test("Start over on a selection reports each result and archives each live conversation", async () => {
	const startOver = spy(
		spyOn(api, "startOver").mockImplementation(async (key: string) => {
			if (key === "discord:today") throw new Error("The conversation is busy.");
			return { ok: true } as never;
		}),
	);
	await open();
	await page.click(button("Select"));
	await until(() => q('[role="toolbar"]') !== null);
	await page.click(button("Select all in section", all(".fold-head")[1]));
	expect(count()).toBe("5 selected");
	await page.click(button("Start over", q('[role="toolbar"]')));
	await until(() => q(".select-result") !== null);
	expect(startOver.mock.calls.map((call) => call[0])).toEqual([
		"discord:scratch",
		"discord:paper",
		"discord:research",
		"discord:recent",
		"discord:today",
	]);
	expect(lastToast()?.textContent).toContain("Started 4 conversations over");
	expect(q(".select-result")?.textContent).toContain("#today");
});

test("each section folds, shows what it holds beside its heading, and the fold survives a reload", async () => {
	await open();
	const heads = all(".fold-head");
	expect(heads).toHaveLength(4);
	expect(heads[0]?.textContent).toContain("1 knight");
	expect(heads[0]?.textContent).toContain("0 groups");
	expect(heads[0]?.textContent).toContain("all idle");
	expect(heads[1]?.textContent).toContain("My workspaces");
	expect(heads[1]?.textContent).toContain("5");
	const body = () =>
		all(".fold-head")[1]?.nextElementSibling as HTMLElement | null;
	// The knights, the outside conversations and the party channels start folded; the workspaces start open.
	expect(
		all(".fold-head").map(
			(one) => (one.nextElementSibling as HTMLElement | null)?.hidden,
		),
	).toEqual([true, false, true, true]);
	expect(body()?.hidden).toBe(false);
	await page.click(heads[1]?.querySelector("button.fold-toggle") ?? null);
	expect(body()?.hidden).toBe(true);
	expect(stored.get(COLLAPSED_KEY)).toContain("section:overview-workspaces");
	// A new page load reads the fold from the device again.
	await page.render(null);
	reloadCollapsed();
	await page.render(<Overview />);
	await until(() => all(".fold-head").length === 4);
	expect(body()?.hidden).toBe(true);
	const hidden = () =>
		all(".fold-head").map(
			(one) => (one.nextElementSibling as HTMLElement | null)?.hidden,
		);
	expect(hidden()).toEqual([true, true, true, true]);
	// Opening a section that starts folded is kept too.
	await page.click(
		all(".fold-head")[0]?.querySelector("button.fold-toggle") ?? null,
	);
	expect(stored.get(COLLAPSED_KEY)).toContain("section:overview-bot-open");
	expect(hidden()).toEqual([false, true, true, true]);
	await settle(10);
});
