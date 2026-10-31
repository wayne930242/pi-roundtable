import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { RoomMessage } from "../src/api-types.ts";
import { ZH_TW } from "../src/i18n/zh-tw.ts";
import { intercomSummary } from "./components/intercom-row.tsx";
import { MessageRow } from "./components/message-row.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { loadBuiltInMessages, setPresentation } from "./lib/messages.ts";

const base = { title: "Console", panes: [] as never[], timeZone: "UTC" };
const peer = { name: "scout", displayName: "Scout" };

const card = (
	id: number,
	intercom: RoomMessage["intercom"],
	text: string,
): RoomMessage => ({
	id,
	room: "app:agent.guide",
	kind: "agent",
	agent: "guide",
	author: "Guide",
	text,
	files: [],
	at: "2026-10-31T10:00:00.000Z",
	...(intercom ? { intercom } : {}),
});

let page: TestPage;
beforeAll(async () => {
	page = await openPage();
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});
afterEach(async () => {
	setPresentation(base);
	await loadBuiltInMessages(undefined);
});

const settle = (ms = 80) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

async function draw(message: RoomMessage) {
	await page.render(
		<ol className="messages">
			<MessageRow
				message={message}
				character={undefined}
				header
				enter={false}
				timeZone="UTC"
				quotable={false}
			/>
		</ol>,
	);
	// The card's row is a lazy chunk.
	await page.act(() => settle());
	return page.container.querySelector<HTMLElement>(
		`li[data-mid="${message.id}"]`,
	);
}

test("a request between agents is one small line, closed, that opens to the whole text", async () => {
	const row = await draw(
		card(
			1,
			{ kind: "sent", peer },
			"## Check the disk\n\nand the logs, please",
		),
	);
	expect(row?.classList.contains("intercom")).toBe(true);
	expect(row?.classList.contains("message")).toBe(false);
	const details = row?.querySelector("details");
	expect(details?.open).toBe(false);
	expect(row?.querySelector("summary")?.textContent).toBe(
		"→ To ScoutCheck the disk",
	);
	expect(row?.querySelector(".intercom-body")?.textContent).toContain(
		"and the logs, please",
	);
	await page.act(async () => {
		row?.querySelector("summary")?.click();
		await settle(10);
	});
	expect(details?.open).toBe(true);
});

test("an answer that fits its line does not open; a failure says no answer came", async () => {
	const answered = await draw(card(2, { kind: "answered", peer }, "disk 80%"));
	expect(answered?.querySelector("details")).toBeNull();
	expect(answered?.textContent).toBe("← From Scoutdisk 80%");
	const failed = await draw(
		card(3, { kind: "failed", peer }, "stopped by the owner"),
	);
	expect(failed?.getAttribute("data-intercom")).toBe("failed");
	expect(failed?.querySelector(".intercom-heading")?.textContent).toBe(
		"No answer from Scout",
	);
});

test("the headings read in Traditional Chinese on a zh-TW page", async () => {
	await loadBuiltInMessages("zh-TW");
	setPresentation({ ...base, locale: "zh-TW" });
	const row = await draw(card(4, { kind: "sent", peer }, "check the disk"));
	expect(row?.querySelector(".intercom-heading")?.textContent).toBe(
		(ZH_TW["→ To {name}"] as string).replace("{name}", "Scout"),
	);
	expect(ZH_TW["← From {name}"]).toBe("← \u4f86\u81ea {name}");
	expect(ZH_TW["No answer from {name}"]).toBe(
		"{name} \u6c92\u6709\u56de\u8986",
	);
});

test("a card's summary is the first line with words, cut with an ellipsis", () => {
	expect(intercomSummary("\n# Title\nbody")).toBe("Title");
	expect(intercomSummary("abcdefghij", 5)).toBe("abcd…");
	expect(intercomSummary(`abc${"😀".repeat(3)}`, 5)).toBe("abc…");
});
