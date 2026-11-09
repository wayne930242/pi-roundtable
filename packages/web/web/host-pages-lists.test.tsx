import { expect, test } from "bun:test";
import HostKindSection from "./components/host-kind-section.tsx";
import {
	buttonNamed,
	fixture,
	hostPagesPage,
	ID,
	installFetch,
	json,
	KIND,
	page,
	pageProps,
	ROOM,
	settle,
	shown,
} from "./host-pages-fixture.tsx";
import { HostPage } from "./pages/host-page.tsx";

hostPagesPage();

test("the list of a kind shows each room with its picture, what needs attention and its unread count, and searches on the host's side", async () => {
	fixture.list = {
		kind: KIND,
		label: "Support inbox",
		rooms: [
			{
				id: ID,
				key: ROOM,
				title: "Invoice 4410",
				subtitle: "Dana",
				picture: { initials: "D", color: "#a04b3a" },
				attention: true,
				unread: 3,
				lastAt: "2026-10-29T10:00:00.000Z",
			},
			...[1, 2, 3, 4, 5].map((n) => ({
				id: `thread-bbbb000${n}`,
				key: `app:inbox.thread-bbbb000${n}`,
				title: `Order ${n}`,
			})),
		],
		cursor: "next-page",
	};
	await shown(
		<HostKindSection kind={KIND} label="Support inbox" active={ROOM} />,
	);
	await settle();
	const rows = [...page.container.querySelectorAll(".room-row")];
	expect(rows).toHaveLength(6);
	expect(rows[0]?.getAttribute("aria-current")).toBe("page");
	expect(rows[0]?.querySelector(".hpic")?.textContent).toBe("D");
	expect(rows[0]?.querySelector(".attention-dot")).not.toBeNull();
	expect(rows[0]?.querySelector(".unread-mark")?.textContent).toBe("3");
	expect(rows[1]?.querySelector(".unread-mark")).toBeNull();
	expect(buttonNamed("Show more")).not.toBeNull();
	// More than a handful of rooms bring a search box, and a search asks the host.
	const search = page.container.querySelector('input[type="search"]');
	await page.act(() => {
		const setter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		setter?.call(search, "dana");
		search?.dispatchEvent(new Event("input", { bubbles: true }));
	});
	// The search goes out once typing pauses; wait for it rather than for a fixed time.
	// Each wait is inside `act`: React's scheduler may have been loaded under an earlier file's DOM, which is gone, so a state change outside `act` is never flushed.
	for (let waited = 0; waited < 2000; waited += 50) {
		if (fixture.requests.some((request) => request.url.includes("filter=dana")))
			break;
		await page.act(async () => {
			await settle(50);
		});
	}
	expect(
		fixture.requests.some((request) => request.url.includes("filter=dana")),
	).toBe(true);
});

test("a host page shows its sections, runs a form's action, and tells the person what the host answered", async () => {
	fixture.pageView = {
		id: "mailboxes",
		title: "Mailboxes",
		sections: [
			{ kind: "markdown", text: "Mailboxes the inbox **reads**." },
			{
				kind: "list",
				title: "Connected",
				rows: [
					{
						title: "support@example.com",
						subtitle: "Synced",
						actions: [{ id: "remove", label: "Remove" }],
					},
					{
						title: "billing@example.com",
						attention: true,
						open: "https://example.com/mail",
					},
				],
			},
			{
				kind: "form",
				action: "connect",
				form: {
					title: "Connect a mailbox",
					submit: "Connect",
					fields: [
						{ name: "address", label: "Address", type: "text", required: true },
					],
				},
			},
			{
				kind: "card",
				card: { title: "Heads up", body: "Check the DNS", state: "done" },
			},
		],
	};
	await shown(<HostPage {...pageProps} />);
	await settle();
	expect(page.container.querySelector("h1")?.textContent).toBe("Mailboxes");
	expect(page.container.querySelector(".prose strong")?.textContent).toBe(
		"reads",
	);
	expect(page.container.querySelectorAll(".host-list > li")).toHaveLength(2);
	expect(
		page.container.querySelector(
			'.host-list a[href="https://example.com/mail"]',
		),
	).not.toBeNull();
	expect(
		page.container.querySelector(".host-card")?.getAttribute("data-state"),
	).toBe("done");
	const input = page.container.querySelector('input[type="text"]');
	await page.act(() => {
		const setter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		setter?.call(input, "ops@example.com");
		input?.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await page.act(() => {
		page.container
			.querySelector("form")
			?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	});
	await settle();
	expect(
		fixture.requests.find((request) =>
			request.url.includes("pages/mailboxes/act"),
		),
	).toMatchObject({
		method: "POST",
		body: { action: "connect", input: { address: "ops@example.com" } },
	});
});

test("a page the viewer may not see is not available", async () => {
	const original = fixture.pageView;
	fixture.pageView = undefined as never;
	globalThis.fetch = (async () =>
		json({ error: "There is no such page." }, 404)) as unknown as typeof fetch;
	try {
		await shown(<HostPage {...pageProps} />);
		await settle();
		expect(page.container.textContent).toContain("This page is not available.");
	} finally {
		fixture.pageView = original;
		installFetch();
	}
});
