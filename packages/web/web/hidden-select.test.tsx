import { afterEach, expect, spyOn, test } from "bun:test";
import type { ArchivedEntry } from "../src/api-types.ts";
import {
	chatsConfig,
	GUIDE,
	loadChats,
	NEWS,
	QUIET,
	T1,
	T2,
} from "./chats-fixture.tsx";
import { Toaster } from "./components/toaster.tsx";
import {
	all,
	dialog,
	foldersPage,
	page,
	q,
	SCOUT,
	settle,
	until,
	view,
} from "./folders-fixture.tsx";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { setHomeMode } from "./lib/home-mode.ts";
import { seedUnread } from "./lib/host-state.ts";
import { layoutApi } from "./lib/layout-api.ts";
import { teamApi } from "./lib/team-api.ts";
import HiddenPage from "./pages/hidden.tsx";

foldersPage();

const DAY = 86_400_000;
const ago = (days: number) =>
	new Date(Date.now() - days * DAY - 3_600_000).toISOString();

const entry = (
	name: string,
	days: number | undefined,
	over: Partial<ArchivedEntry> = {},
): ArchivedEntry => ({
	kind: "agent",
	name,
	displayName: name.toUpperCase(),
	...(days === undefined ? {} : { lastActive: ago(days) }),
	...over,
});

/** Three idle for 30+ days, three for 7–30, two recent. */
const ARCHIVE = [
	entry("old-a", 40),
	entry("old-b", 45),
	entry("old-c", 90),
	entry("mid-a", 10),
	entry("mid-b", 12),
	entry("mid-c", 20),
	entry("new-a", 1),
	entry("new-b", 2),
];

const Hidden = () => (
	<ConfigContext.Provider value={chatsConfig}>
		<HiddenPage />
		<Toaster />
	</ConfigContext.Provider>
);

const spies: { mockRestore(): void }[] = [];
const spy = <T extends { mockRestore(): void }>(one: T): T => {
	spies.push(one);
	return one;
};
afterEach(() => {
	for (const one of spies.splice(0)) one.mockRestore();
	setHomeMode("rooms");
	store.dispatch({ type: "layout_loaded", pins: [], hidden: [], folders: [] });
});

const archiveOf = (entries: ArchivedEntry[]) =>
	spy(spyOn(teamApi, "archive").mockResolvedValue({ entries }));

/** Stubs what a finished batch reads again, so no test reaches for the network. */
const quiet = () =>
	spy(
		spyOn(api, "rooms").mockResolvedValue({
			rooms: [],
			pins: [],
			hidden: [],
			folders: [],
		}),
	);

const box = (name: string) =>
	all<HTMLInputElement>('input[type="checkbox"]').find(
		(one) => one.getAttribute("aria-label") === name,
	) ?? null;
/** A button by its words inside `within` (the page when omitted); none when `within` is not there. */
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
/** The newest notice: they outlive a test, so an older one may still be on the page. */
const lastToast = () => all(".toast").at(-1) ?? null;
/** Puts away the notices an earlier test left. */
const fresh = () =>
	page.act(() => {
		for (const one of all<HTMLButtonElement>(
			'.toast button[aria-label="Dismiss"]',
		))
			one.click();
	});
const bar = () => q('[role="toolbar"]');
const count = () => q(".select-count")?.textContent;

async function open(entries: ArchivedEntry[] = ARCHIVE) {
	archiveOf(entries);
	await page.render(<Hidden />);
	await fresh();
	await until(() => all("li.menu-item").length === entries.length);
}
const select = async () => {
	await page.click(button("Select"));
	await until(() => bar() !== null);
};

test("Select shows a checkbox named by each row, and Done leaves selection mode", async () => {
	await open();
	expect(all('input[type="checkbox"]')).toHaveLength(0);
	await select();
	expect(box("OLD-A")).not.toBeNull();
	expect(all('input[type="checkbox"]')).toHaveLength(ARCHIVE.length);
	expect(bar()?.getAttribute("role")).toBe("toolbar");
	expect(count()).toBe("0 selected");
	await page.click(button("Done"));
	expect(bar()).toBeNull();
	expect(all('input[type="checkbox"]')).toHaveLength(0);
});

test("a hold on an archived row starts selection with that row chosen", async () => {
	await open();
	const row = all("li.menu-item")[0];
	await page.act(async () => {
		row?.dispatchEvent(
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
	await until(() => bar() !== null);
	expect(box("OLD-A")?.checked).toBe(true);
	expect(count()).toBe("1 selected");
});

test("archived rows say when they were last active", async () => {
	await open();
	const text = all("li.menu-item")
		.map((one) => one.textContent)
		.join("|");
	expect(text).toContain("40 d ago");
	expect(text).toContain("90 d ago");
	expect(text).toContain("1 d ago");
});

test("the age chips carry their counts, and Select all selects exactly the rows a chip shows", async () => {
	await open([...ARCHIVE, entry("never", undefined)]);
	await select();
	const chips = all("fieldset.select-chips button").map((one) =>
		one.textContent?.replace(/\s+/g, " "),
	);
	// A knight with no message at all counts as idle for any filter.
	expect(chips).toEqual([
		"All 9",
		"No activity for 7+ days 7",
		"No activity for 30+ days 4",
	]);
	await page.click(button("No activity for 30+ days"));
	expect(all("li.menu-item")).toHaveLength(4);
	await page.click(button("Select all in section"));
	expect(count()).toBe("4 selected");
	expect(box("NEW-A")).toBeNull();
	// Another filter starts the choice over.
	await page.click(button("No activity for 7+ days"));
	expect(count()).toBe("0 selected");
	await page.click(button("Select all in section"));
	expect(count()).toBe("7 selected");
	await page.click(button("Clear selection"));
	expect(count()).toBe("0 selected");
});

test("a choice in another section clears the first", async () => {
	archiveOf(ARCHIVE);
	loadChats({ hidden: [QUIET, NEWS] }, [
		view(GUIDE, { home: true }),
		view(SCOUT),
		view(NEWS),
		view(QUIET),
	]);
	seedUnread({});
	await page.render(<Hidden />);
	await fresh();
	await until(() => all("li.menu-item").length === ARCHIVE.length);
	await select();
	await page.click(box("quiet"));
	await page.click(box("news"));
	expect(count()).toBe("2 selected");
	expect(button("Unhide", bar())).not.toBeNull();
	await page.click(box("OLD-A"));
	expect(count()).toBe("1 selected");
	expect(box("quiet")?.checked).toBe(false);
	expect(box("news")?.checked).toBe(false);
	expect(button("Unhide", bar())).toBeNull();
	expect(button("Restore", bar())).not.toBeNull();
});

test("Unhide shows each chosen room again, and the notice's Undo hides them again", async () => {
	archiveOf([]);
	const hide = spy(
		spyOn(layoutApi, "hideRoom").mockResolvedValue({
			pins: [],
			hidden: [],
			folders: [],
		}),
	);
	loadChats({ hidden: [QUIET, NEWS] }, [
		view(GUIDE, { home: true }),
		view(NEWS),
		view(QUIET),
	]);
	await page.render(<Hidden />);
	await fresh();
	await until(() => all(".hidden-room").length === 2);
	await select();
	await page.click(box("quiet"));
	await page.click(box("news"));
	await page.click(button("Unhide", bar()));
	await until(() => hide.mock.calls.length === 2);
	expect(hide.mock.calls.map((call) => call.slice(0, 2))).toEqual([
		[QUIET, false],
		[NEWS, false],
	]);
	await until(() => lastToast() !== null);
	expect(lastToast()?.textContent).toContain("Unhid 2 rooms");
	await page.click(button("Undo", lastToast()));
	await until(() => hide.mock.calls.length === 4);
	expect(hide.mock.calls.slice(2).map((call) => call.slice(0, 2))).toEqual([
		[QUIET, true],
		[NEWS, true],
	]);
});

test("Dismiss clears each chosen dispatch thread, and Undo puts them back", async () => {
	archiveOf([]);
	const dismiss = spy(
		spyOn(api, "dismissThread").mockResolvedValue({ dismissed: 1 }),
	);
	const undismiss = spy(
		spyOn(api, "undismissThread").mockResolvedValue({ restored: 1 }),
	);
	loadChats({}, [
		view(GUIDE, { home: true }),
		view(T1, {
			kind: "thread",
			parent: "app:agent.gone",
			readOnly: true,
			closed: true,
		}),
		view(T2, {
			kind: "thread",
			parent: "app:agent.gone",
			readOnly: true,
			closed: true,
		}),
	]);
	await page.render(<Hidden />);
	await fresh();
	await until(() => q(".thread-card, .thread-group") !== null);
	await select();
	await until(() => all(".select-row").length === 2);
	await page.click(button("Select all in section"));
	expect(count()).toBe("2 selected");
	await page.click(button("Dismiss", bar()));
	await until(() => dismiss.mock.calls.length === 2);
	expect(dismiss.mock.calls.map((call) => call[0]).sort()).toEqual([T1, T2]);
	await until(() => lastToast() !== null);
	expect(lastToast()?.textContent).toContain("Cleared 2 threads");
	await page.click(button("Undo", lastToast()));
	await until(() => undismiss.mock.calls.length === 2);
	expect(undismiss.mock.calls.map((call) => call[0]).sort()).toEqual([T1, T2]);
});

test("Restore puts each chosen entry back, and Undo archives them again", async () => {
	quiet();
	const restore = spy(
		spyOn(teamApi, "restoreAgent").mockResolvedValue({} as never),
	);
	const archive = spy(
		spyOn(teamApi, "archiveAgent").mockResolvedValue({ ok: true }),
	);
	await open();
	await select();
	await page.click(box("OLD-A"));
	await page.click(box("MID-A"));
	await page.click(button("Restore", bar()));
	await until(() => restore.mock.calls.length === 2);
	expect(restore.mock.calls.map((call) => call[0])).toEqual(["old-a", "mid-a"]);
	await until(() => lastToast() !== null);
	expect(lastToast()?.textContent).toContain("Restored 2 entries");
	await page.click(button("Undo", lastToast()));
	await until(() => archive.mock.calls.length === 2);
	expect(archive.mock.calls.map((call) => call[0])).toEqual(["mid-a", "old-a"]);
});

test("Delete for good asks first, naming the items with the count on the button, and sends each once", async () => {
	quiet();
	const remove = spy(
		spyOn(teamApi, "deleteAgent").mockResolvedValue({ ok: true }),
	);
	await open();
	await select();
	await page.click(button("No activity for 30+ days"));
	await page.click(button("Select all in section"));
	await page.click(button("Delete for good", bar()));
	const asking = dialog("Delete 3 items for good?");
	await until(() => dialog("Delete 3 items for good?")?.open === true);
	expect(asking?.textContent).toContain("OLD-A");
	expect(asking?.textContent).toContain("OLD-C");
	expect(asking?.textContent).toContain("This cannot be undone.");
	expect(button("Delete 3 for good", asking)).not.toBeNull();
	expect(remove).not.toHaveBeenCalled();
	await page.click(button("Delete 3 for good", asking));
	await until(() => remove.mock.calls.length === 3);
	expect(remove.mock.calls.map((call) => call[0])).toEqual([
		"old-a",
		"old-b",
		"old-c",
	]);
});

test("the question lists eight names and then how many more", async () => {
	quiet();
	const many = Array.from({ length: 11 }, (_, i) => entry(`n${i}`, 40));
	await open(many);
	await select();
	await page.click(button("Select all in section"));
	await page.click(button("Delete for good", bar()));
	await until(() => dialog("Delete 11 items for good?")?.open === true);
	const names = all("dialog[open] .confirm-names li").map(
		(one) => one.textContent,
	);
	expect(names).toHaveLength(9);
	expect(names.at(-1)).toBe("and 3 more");
});

test("a knight is chosen with its temp knights, which are not sent on their own, and the question counts them", async () => {
	quiet();
	const remove = spy(
		spyOn(teamApi, "deleteAgent").mockResolvedValue({ ok: true }),
	);
	await open([
		entry("blog", 3),
		entry("blog-7", 3, { parent: "blog", displayName: "BLOG #7" }),
		entry("blog-8", 3, { parent: "blog", displayName: "BLOG #8" }),
		entry("daily", 6),
	]);
	await select();
	await page.click(box("BLOG"));
	expect(box("BLOG #7")?.checked).toBe(true);
	expect(box("BLOG #8")?.checked).toBe(true);
	expect(box("BLOG #7")?.disabled).toBe(true);
	expect(count()).toBe("3 selected");
	await page.click(button("Delete for good", bar()));
	await until(() => dialog("Delete 3 items for good?")?.open === true);
	expect(dialog("Delete 3 items for good?")?.textContent).toContain(
		"2 temp knights go with their knights.",
	);
	await page.click(
		button("Delete 3 for good", dialog("Delete 3 items for good?")),
	);
	await until(() => remove.mock.calls.length === 1);
	await page.act(async () => {
		await settle(60);
	});
	expect(remove.mock.calls.map((call) => call[0])).toEqual(["blog"]);
});

test("one temp knight can be chosen alone", async () => {
	await open([
		entry("blog", 3),
		entry("blog-7", 3, { parent: "blog", displayName: "BLOG #7" }),
	]);
	await select();
	await page.click(box("BLOG #7"));
	expect(count()).toBe("1 selected");
	expect(box("BLOG")?.checked).toBe(false);
});

test("a run shows its progress, goes on after a refusal, and the result names the row and the server's words", async () => {
	quiet();
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const remove = spy(
		spyOn(teamApi, "deleteAgent").mockImplementation(async (name: string) => {
			if (name === "old-a") await gate;
			if (name === "old-b")
				throw new Error('"old-b" is set up in the configuration.');
			return { ok: true };
		}),
	);
	await open();
	await select();
	await page.click(button("No activity for 30+ days"));
	await page.click(button("Select all in section"));
	await page.click(button("Delete for good", bar()));
	await until(() => dialog("Delete 3 items for good?")?.open === true);
	await page.click(
		button("Delete 3 for good", dialog("Delete 3 items for good?")),
	);
	await until(() => q("progress") !== null);
	expect(count()).toBe("Deleting 0 / 3");
	expect(q("progress")?.getAttribute("max")).toBe("3");
	expect(button("Restore", bar())?.disabled).toBe(true);
	await page.act(() => release());
	await until(() => q(".select-result") !== null);
	expect(remove.mock.calls.map((call) => call[0])).toEqual([
		"old-a",
		"old-b",
		"old-c",
	]);
	const result = q(".select-result")?.textContent ?? "";
	expect(result).toContain("1 was not done:");
	expect(result).toContain("OLD-B");
	expect(result).toContain("is set up in the configuration");
	expect(lastToast()?.textContent).toContain("Deleted 2 entries");
	// The delete cannot be undone, so its notice has no Undo.
	expect(button("Undo", lastToast())).toBeNull();
	await page.click(button("Dismiss", q(".select-result")));
	expect(q(".select-result")).toBeNull();
});
