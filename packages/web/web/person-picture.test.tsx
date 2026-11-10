import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { CATALOG, type CharacterSpec } from "pi-roundtable/characters";
import { HomeTop } from "./components/home-top.tsx";
import { HostPicture, PersonPicture } from "./components/host-picture.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { loadKit } from "./lib/kit.ts";

const specOf = (id: "knight" | "wizard" | "healer"): CharacterSpec => ({
	v: 1,
	class: id,
	...CATALOG.classes[id].preset,
});

/** What `api/people/<id>/character` answers for each person: a knight, 404 for none, or a failure. */
const knights = new Map<string, CharacterSpec | "broken">();
let asked: string[] = [];
const realFetch = globalThis.fetch;

let page: TestPage;
beforeAll(async () => {
	await loadKit();
	page = await openPage();
	globalThis.fetch = (async (url: string | URL | Request) => {
		const path = String(url);
		asked.push(path);
		const id = /api\/people\/([^/]+)\/character$/.exec(path)?.[1];
		const knight = id === undefined ? undefined : knights.get(id);
		if (knight === "broken") return new Response("{}", { status: 500 });
		return knight
			? Response.json({ character: knight })
			: Response.json({ error: "There is no character." }, { status: 404 });
	}) as typeof fetch;
});
afterEach(async () => {
	await page.render(null);
	asked = [];
});
afterAll(async () => {
	globalThis.fetch = realFetch;
	await page.unmount();
	await releaseDom();
});

const settle = (ms = 60) =>
	page.act(() => new Promise<void>((done) => setTimeout(done, ms)));

/** Signs the page in as `id`, with the knight `ready` carried when one is given. */
const signIn = (id: string, character?: CharacterSpec) =>
	store.dispatch({
		type: "ready",
		protocol: 1,
		principal: id,
		name: id,
		...(character ? { character } : {}),
		uploads: { perMessage: 4, maxBytes: 1000 },
	} as never);

const drawn = (root: ParentNode = page.container) =>
	[...root.querySelectorAll<HTMLElement>(".hpic")].map((one) =>
		one.querySelector(".av-host[data-badge] svg")
			? "knight"
			: one.querySelector("img")
				? `picture ${one.querySelector("img")?.getAttribute("src")}`
				: `initials ${one.textContent}`,
	);

test("a person with a knight is drawn as the knight; one without, by their account picture, then their initials", async () => {
	signIn("viewer");
	knights.set("p-knight", specOf("wizard"));
	await page.render(
		<>
			<PersonPicture principal="p-knight" name="Dana Wu" />
			<PersonPicture principal="p-plain" name="Mel Ito" />
		</>,
	);
	await settle();
	expect(drawn()).toEqual(["knight", "picture api/people/p-plain/picture"]);
	// The knight stands on the page's accent badge, still, at the size asked for.
	const host = page.container.querySelector<HTMLElement>(".av-host");
	expect(host?.classList.contains("static")).toBe(true);
	expect(host?.style.width).toBe("32px");
	// The account has no picture to serve: the initials stand in.
	const image = page.container.querySelector("img");
	await page.act(() => {
		image?.dispatchEvent(new Event("error"));
	});
	expect(drawn()).toEqual(["knight", "initials MI"]);
});

test("two pictures of one person share a single fetch, and a later one asks nothing", async () => {
	signIn("viewer");
	knights.set("p-twice", specOf("healer"));
	await page.render(
		<>
			<PersonPicture principal="p-twice" name="Sam" />
			<PersonPicture principal="p-twice" name="Sam" size={16} />
		</>,
	);
	await settle();
	expect(drawn()).toEqual(["knight", "knight"]);
	expect(asked).toEqual(["api/people/p-twice/character"]);
	await page.render(null);
	await page.render(<PersonPicture principal="p-twice" name="Sam" />);
	// Known already: the knight is there on the first draw, and nothing is fetched.
	expect(drawn()).toEqual(["knight"]);
	expect(asked).toEqual(["api/people/p-twice/character"]);
});

test("the viewer's own knight comes from the store, with no fetch, and follows a save or a removal", async () => {
	signIn("me-1", specOf("knight"));
	await page.render(<PersonPicture principal="me-1" name="Wei Hung" />);
	await settle();
	expect(drawn()).toEqual(["knight"]);
	expect(asked).toEqual([]);
	await page.act(() => {
		store.dispatch({ type: "knight", character: undefined });
	});
	expect(drawn()).toEqual(["picture api/people/me-1/picture"]);
	await page.act(() => {
		store.dispatch({ type: "knight", character: specOf("wizard") });
	});
	expect(drawn()).toEqual(["knight"]);
	expect(asked).toEqual([]);
	// A reconnect without a knight (removed on another device) takes it away here too.
	await page.act(() => {
		signIn("me-1");
	});
	expect(drawn()).toEqual(["picture api/people/me-1/picture"]);
});

test("a knight that could not be fetched leaves the account picture, and the next picture asks again", async () => {
	signIn("viewer");
	knights.set("p-flaky", "broken");
	await page.render(<PersonPicture principal="p-flaky" name="Flo" />);
	await settle();
	expect(drawn()).toEqual(["picture api/people/p-flaky/picture"]);
	knights.set("p-flaky", specOf("wizard"));
	await page.render(null);
	await page.render(<PersonPicture principal="p-flaky" name="Flo" />);
	await settle();
	expect(drawn()).toEqual(["knight"]);
	expect(asked).toEqual([
		"api/people/p-flaky/character",
		"api/people/p-flaky/character",
	]);
});

test("a knight the kit refuses is no knight: the account picture shows", async () => {
	signIn("viewer");
	knights.set("p-odd", { v: 1, class: "gone" } as never);
	await page.render(<PersonPicture principal="p-odd" name="Odd" />);
	await settle();
	expect(drawn()).toEqual(["picture api/people/p-odd/picture"]);
});

test("HostPicture draws a person through the same path, and asks nothing for a file or given initials", async () => {
	signIn("viewer");
	knights.set("p-seen", specOf("knight"));
	await page.render(
		<>
			<HostPicture picture={{ principal: "p-seen" }} name="Ada" size={16} />
			<HostPicture picture={{ file: "f1" }} name="Shop" />
			<HostPicture picture={{ initials: "D", color: "#a04b3a" }} name="Dee" />
			<HostPicture name="Nobody Known" />
		</>,
	);
	await settle();
	expect(drawn()).toEqual([
		"knight",
		"picture api/files/f1",
		"initials D",
		"initials NK",
	]);
	expect(asked).toEqual(["api/people/p-seen/character"]);
	// The 16 px face of the "seen by" line is the knight at that size.
	expect(
		page.container.querySelector<HTMLElement>(".av-host")?.style.width,
	).toBe("16px");
});

test("the chat home's own picture is the person's knight inside the menu button, or their picture without one", async () => {
	signIn("me-2", specOf("healer"));
	const config = {
		title: "Console",
		panes: ["rooms", "profile"],
		timeZone: "UTC",
	} as never;
	await page.render(
		<ConfigContext.Provider value={config}>
			<HomeTop onAdd={() => undefined} />
		</ConfigContext.Provider>,
	);
	await settle();
	const button = page.container.querySelector<HTMLElement>("button.chats-me");
	expect(button?.getAttribute("aria-haspopup")).toBe("menu");
	expect(drawn(button ?? undefined)).toEqual(["knight"]);
	expect(button?.querySelector<HTMLElement>(".av-host")?.style.width).toBe(
		"44px",
	);
	await page.act(() => {
		store.dispatch({ type: "knight", character: undefined });
	});
	expect(drawn(button ?? undefined)).toEqual([
		"picture api/people/me-2/picture",
	]);
	expect(asked).toEqual([]);
});

test("a picture that failed once is not asked for again by the next mount", async () => {
	signIn("viewer");
	await page.render(<PersonPicture principal="p-nopic" name="Nia Po" />);
	await settle();
	expect(drawn()).toEqual(["picture api/people/p-nopic/picture"]);
	await page.act(() => {
		page.container.querySelector("img")?.dispatchEvent(new Event("error"));
	});
	expect(drawn()).toEqual(["initials NP"]);
	await page.render(null);
	await page.render(
		<>
			<PersonPicture principal="p-nopic" name="Nia Po" />
			<PersonPicture principal="p-nopic" name="Nia Po" size={16} />
		</>,
	);
	await settle();
	expect(drawn()).toEqual(["initials NP", "initials NP"]);
	expect(page.container.querySelectorAll("img").length).toBe(0);
});

test("the viewer's own knight that the kit refuses falls back to the account picture", async () => {
	signIn("me-odd", { v: 1, class: "gone" } as never);
	await page.render(<PersonPicture principal="me-odd" name="Odd Me" />);
	await settle();
	expect(drawn()).toEqual(["picture api/people/me-odd/picture"]);
});
